// ─────────────────────────────────────────────────────────────────────────
// DRY-RUN (읽기 전용) SoT 정합성 스캐너 — 아무 것도 쓰지 않는다.
//
// 전역 SoT 발산(관리자에서 결과 변경 → 일부 화면만 반영) 을 운영 DB 대상으로 정량화한다.
// 판정은 반드시 "실제 엔진"을 재사용한다(재구현 금지) — 오탐 방지:
//   · uws 재판정      = predictWeekStatusForUser (crewWeekGrowthRejudge)
//   · 품계(상대 백분위) = getClubRankGradeBatch  (cluster3ClubRankData)
//   · 카드 스냅샷      = readWeeklyCardsSnapshot  (cluster4WeeklyCardsSnapshot)
//   · 전환주차 제외    = isTransitionWeekStart    (seasonCalendar)
//
// 검사 클래스(사용자 요청 10종 중 오탐 없이 원장만으로 판정 가능한 것 우선):
//   C1  uws.status        vs 현재 판정기(predict)                [--with-predict, 느림]
//   C2  카드 스냅샷 status vs uws.status (terminal 만 비교)
//   C6o 라인 A/B 원장은 있는데 target 없음 (orphan award)          ← R1 DELETE 경로 직접 증거
//   C8  2차 기입 허용인데 target 없음
//   C9  user_growth_stats.approved_weeks vs uws success 카운트
//   C10 user_grade_stats(grade/percentile) vs live getClubRankGradeBatch  ← R3 드리프트
//
// 미구현(문서화): C3/C4(성공↔target)·C5(성공인데 A/B 없음)·C7(2차허용인데 강화≠성공)은
//   (user,week,line) 단위 강화엔진 평가가 필요 → deep pass 별도. v1 은 원장 레벨 고확신 클래스만.
//
// 사용:
//   npx tsx --env-file=.env.local scripts/dryrun_sot_consistency_scan.ts [org|all] [--with-predict] [--limit=N] [--samples=N]
// ─────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

const args = process.argv.slice(2);
const ORG_FILTER = args[0] && !args[0].startsWith("--") && args[0] !== "all" ? args[0] : null;
const PREDICT_ONLY = args.includes("--predict-only");
const WITH_PREDICT = args.includes("--with-predict") || PREDICT_ONLY;
const LIMIT = ((): number | null => {
  const a = args.find((x) => x.startsWith("--limit="));
  return a ? Number(a.split("=")[1]) || null : null;
})();
const SAMPLES = ((): number => {
  const a = args.find((x) => x.startsWith("--samples="));
  return a ? Number(a.split("=")[1]) || 8 : 8;
})();
const now = Date.now();

// terminal(원장에 실제 확정되는) 상태만 — 카드의 runtime status(running/tallying/…)는 비교 제외.
const DB_TERMINAL = new Set(["success", "fail", "personal_rest", "official_rest"]);
const isSuccess = (s: string | null | undefined) => s === "success";

type WeekMeta = { id: string; start_date: string | null };

// PostgREST 1000행 cap 방어 — .range() 로 전 행 페이지네이션.
async function paginate<T>(
  build: () => any,
  page = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
    from += page;
  }
  return out;
}

function pct(n: number, d: number) {
  return d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
  console.log(
    `\n═══ SoT 정합성 DRY-RUN (읽기 전용) ═══  org=${ORG_FILTER ?? "전체"}  predict=${WITH_PREDICT ? "ON" : "OFF"}${LIMIT ? `  limit=${LIMIT}` : ""}\n`,
  );

  // ── 공통 로드 ────────────────────────────────────────────────────────────
  const { data: weekRows } = await supabaseAdmin.from("weeks").select("id, start_date");
  const weeks = (weekRows ?? []) as WeekMeta[];
  const weekIdByStart = new Map<string, string>();
  for (const w of weeks) if (w.start_date) weekIdByStart.set(w.start_date, w.id);

  let profq = supabaseAdmin.from("user_profiles").select("user_id, display_name, organization_slug");
  if (ORG_FILTER) profq = profq.eq("organization_slug", ORG_FILTER);
  const profs = await paginate<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
    () => profq,
  );
  const orgByUser = new Map<string, OrganizationSlug | null>();
  const nameByUser = new Map<string, string>();
  for (const p of profs) {
    orgByUser.set(
      p.user_id,
      p.organization_slug && isOrganizationSlug(p.organization_slug)
        ? (p.organization_slug as OrganizationSlug)
        : null,
    );
    nameByUser.set(p.user_id, p.display_name ?? "?");
  }
  let userIds = [...orgByUser.keys()];
  if (LIMIT) userIds = userIds.slice(0, LIMIT);
  const userSet = new Set(userIds);
  const nm = (u: string) => `${nameByUser.get(u) ?? "?"}(${u.slice(0, 8)})`;
  console.log(`대상 유저: ${userIds.length}${ORG_FILTER ? ` · org=${ORG_FILTER}` : ""}\n`);

  // 전 유저 uws 를 한 번에 (페이지네이션). key = user → [{start,status}]
  console.log("· user_week_statuses 로드 중…");
  // 전체를 페이지네이션으로 읽고 userSet 으로 메모리 필터(org/limit 무관하게 정확).
  const allUws = await paginate<{
    user_id: string;
    status: string;
    week_start_date: string | null;
  }>(() => supabaseAdmin.from("user_week_statuses").select("user_id,status,week_start_date"));
  const uwsByUser = new Map<string, Array<{ start: string; status: string }>>();
  for (const r of allUws) {
    if (!userSet.has(r.user_id)) continue;
    if (!r.week_start_date) continue;
    const arr = uwsByUser.get(r.user_id) ?? [];
    arr.push({ start: r.week_start_date, status: r.status });
    uwsByUser.set(r.user_id, arr);
  }

  const summary: Array<{ code: string; label: string; checked: number; mismatch: number; users: number }> = [];
  const affectedUsersGlobal = new Set<string>();

  // ── C10  품계 캐시 vs live ─────────────────────────────────────────────
  if (!PREDICT_ONLY) {
    console.log("· C10 품계(user_grade_stats) vs live 계산 중…");
    const cacheRows = await paginate<{ user_id: string; grade: number | null; avg_percentile: number | null }>(
      () => supabaseAdmin.from("user_grade_stats").select("user_id,grade,avg_percentile"),
    );
    const cacheById = new Map(cacheRows.filter((r) => userSet.has(r.user_id)).map((r) => [r.user_id, r]));
    const live = await getClubRankGradeBatch([...cacheById.keys()]);
    const r1 = (n: number | null | undefined) => (n == null ? null : Math.round(Number(n) * 10) / 10); // 표시 precision
    let gradeMismatch = 0; // 품계 숫자(뱃지) 변동 — material
    let pctDrift = 0; // 품계 동일·백분위만 드리프트 — 표시
    const users = new Set<string>();
    const samples: string[] = [];
    for (const [uid, c] of cacheById) {
      const l = live.get(uid) ?? null;
      const liveGrade = l?.grade ?? null;
      const livePct = r1(l?.avgPercentile ?? null);
      const cachePct = r1(c.avg_percentile ?? null);
      const gradeDiff = (c.grade ?? null) !== (liveGrade ?? null);
      const pctDiff = cachePct !== livePct;
      if (gradeDiff) {
        gradeMismatch++;
        users.add(uid);
        affectedUsersGlobal.add(uid);
        if (samples.length < SAMPLES)
          samples.push(`    [품계변동] ${nm(uid)}  grade ${c.grade}→${liveGrade}  pct ${cachePct}→${livePct}`);
      } else if (pctDiff) {
        pctDrift++;
        users.add(uid);
      }
    }
    summary.push({
      code: "C10",
      label: `품계 캐시 vs live (품계변동/백분위드리프트=${gradeMismatch}/${pctDrift})`,
      checked: cacheById.size,
      mismatch: gradeMismatch,
      users: users.size,
    });
    if (samples.length) console.log(samples.join("\n"));
    console.log(`    → 품계 숫자 변동 ${gradeMismatch}명 · 백분위만 드리프트 ${pctDrift}명 (품계 동일)`);
  }

  // ── C9  성장통계 approved_weeks vs uws success 카운트 ──────────────────
  if (!PREDICT_ONLY) {
    console.log("· C9 user_growth_stats.approved_weeks vs uws success…");
    const gs = await paginate<{ user_id: string; approved_weeks: number | null; cumulative_weeks: number | null }>(
      () => supabaseAdmin.from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks"),
    );
    let mismatch = 0;
    let checked = 0;
    const users = new Set<string>();
    const samples: string[] = [];
    for (const g of gs) {
      if (!userSet.has(g.user_id)) continue;
      checked++;
      const rows = (uwsByUser.get(g.user_id) ?? []).filter((r) => !isTransitionWeekStart(r.start));
      const liveApproved = rows.filter((r) => r.status === "success").length;
      const liveCumulative = rows.length;
      if ((g.approved_weeks ?? 0) !== liveApproved || (g.cumulative_weeks ?? 0) !== liveCumulative) {
        mismatch++;
        users.add(g.user_id);
        affectedUsersGlobal.add(g.user_id);
        if (samples.length < SAMPLES)
          samples.push(
            `    ${nm(g.user_id)}  approved ${g.approved_weeks}→${liveApproved}  cumulative ${g.cumulative_weeks}→${liveCumulative}`,
          );
      }
    }
    summary.push({ code: "C9", label: "성장통계 누적/성공주차", checked, mismatch, users: users.size });
    if (samples.length) console.log(samples.join("\n"));
  }

  // ── C6o  라인 A/B 원장 있는데 target 없음 (orphan award) ───────────────
  if (!PREDICT_ONLY) {
    console.log("· C6o orphan line award (A/B 원장 vs target)…");
    const awards = await paginate<{
      ref_id: string;
      user_id: string;
      point_check: number | null;
      point_advantage: number | null;
    }>(() =>
      supabaseAdmin
        .from("process_point_awards")
        .select("ref_id,user_id,point_check,point_advantage")
        .eq("source", "line")
        .is("cancelled_at", null),
    );
    const targets = await paginate<{ line_id: string; target_user_id: string | null }>(() =>
      supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id,target_user_id")
        .eq("target_mode", "user"),
    );
    const targetSet = new Set(targets.filter((t) => t.target_user_id).map((t) => `${t.line_id}|${t.target_user_id}`));
    let mismatch = 0;
    let checked = 0;
    let orphanedPoints = 0;
    const users = new Set<string>();
    const samples: string[] = [];
    for (const a of awards) {
      if (!userSet.has(a.user_id)) continue;
      checked++;
      if (!targetSet.has(`${a.ref_id}|${a.user_id}`)) {
        mismatch++;
        users.add(a.user_id);
        affectedUsersGlobal.add(a.user_id);
        orphanedPoints += (a.point_check ?? 0) + (a.point_advantage ?? 0);
        if (samples.length < SAMPLES)
          samples.push(`    ${nm(a.user_id)}  line=${a.ref_id.slice(0, 8)}  A=${a.point_check} B=${a.point_advantage}`);
      }
    }
    summary.push({ code: "C6o", label: "orphan 라인 A/B(target 없음)", checked, mismatch, users: users.size });
    if (samples.length) console.log(samples.join("\n"));
    if (mismatch) console.log(`    → 고아 상태로 합산 중인 포인트(A+B) 합계: ${orphanedPoints}`);
  }

  // ── C8  2차 기입 허용인데 target 없음 ─────────────────────────────────
  if (!PREDICT_ONLY) {
    console.log("· C8 2차 기입 override(allowed) vs target…");
    const ov = await paginate<{ user_id: string; line_id: string; allowed: boolean }>(() =>
      supabaseAdmin
        .from("cluster4_line_second_entry_overrides")
        .select("user_id,line_id,allowed")
        .eq("allowed", true),
    );
    const targets = await paginate<{ line_id: string; target_user_id: string | null }>(() =>
      supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id,target_user_id")
        .eq("target_mode", "user"),
    );
    const targetSet = new Set(targets.filter((t) => t.target_user_id).map((t) => `${t.line_id}|${t.target_user_id}`));
    let mismatch = 0;
    let checked = 0;
    const users = new Set<string>();
    const samples: string[] = [];
    for (const o of ov) {
      if (!userSet.has(o.user_id)) continue;
      checked++;
      if (!targetSet.has(`${o.line_id}|${o.user_id}`)) {
        mismatch++;
        users.add(o.user_id);
        affectedUsersGlobal.add(o.user_id);
        if (samples.length < SAMPLES) samples.push(`    ${nm(o.user_id)}  line=${o.line_id.slice(0, 8)}`);
      }
    }
    summary.push({ code: "C8", label: "2차허용인데 target 없음", checked, mismatch, users: users.size });
    if (samples.length) console.log(samples.join("\n"));
  }

  // ── C2  카드 스냅샷 status vs uws (terminal 만) ───────────────────────
  if (!PREDICT_ONLY) {
    console.log("· C2 weekly-card snapshot vs uws (terminal 비교)…");
    let mismatch = 0;
    let checked = 0;
    let staleVer = 0; // version_mismatch
    let staleFlag = 0; // is_stale
    let missSnap = 0;
    let cardTermNoUws = 0; // 카드 terminal 인데 uws 행 없음
    let cardRuntime = 0; // 카드가 runtime(running/tallying 등) — 비교 제외
    const users = new Set<string>();
    const samples: string[] = [];
    const sampleNoUws: string[] = [];
    let processed = 0;
    for (const uid of userIds) {
      const snap = await readWeeklyCardsSnapshot(uid);
      if (snap.status === "miss") missSnap++;
      if (snap.status === "stale") (snap.reason === "version_mismatch" ? staleVer++ : staleFlag++);
      if (snap.status !== "hit" && snap.status !== "stale") continue;
      const cards = snap.cards ?? [];
      const uwsMap = new Map((uwsByUser.get(uid) ?? []).map((r) => [r.start, r.status]));
      for (const card of cards as Array<{ startDate?: string; resultStatus?: string }>) {
        const cardStatus = card.resultStatus;
        if (!card.startDate || !cardStatus) continue;
        if (!DB_TERMINAL.has(cardStatus)) {
          cardRuntime++;
          continue;
        }
        const uwsStatus = uwsMap.get(card.startDate);
        if (uwsStatus == null) {
          cardTermNoUws++;
          if (sampleNoUws.length < SAMPLES)
            sampleNoUws.push(`    ${nm(uid)}  ${card.startDate}  card=${cardStatus} · uws 없음`);
          continue;
        }
        if (!DB_TERMINAL.has(uwsStatus)) continue;
        checked++;
        if (isSuccess(cardStatus) !== isSuccess(uwsStatus)) {
          mismatch++;
          users.add(uid);
          affectedUsersGlobal.add(uid);
          if (samples.length < SAMPLES)
            samples.push(`    ${nm(uid)}  ${card.startDate}  card=${cardStatus} vs uws=${uwsStatus}`);
        }
      }
      if (++processed % 50 === 0) console.log(`    …${processed}/${userIds.length}`);
    }
    summary.push({ code: "C2", label: "스냅샷 status vs uws", checked, mismatch, users: users.size });
    if (samples.length) console.log(samples.join("\n"));
    console.log(
      `    스냅샷 상태: miss=${missSnap} · version_mismatch=${staleVer} · is_stale=${staleFlag}`,
    );
    console.log(
      `    카드 진단: runtime(비교제외)=${cardRuntime} · terminal-but-uws없음=${cardTermNoUws}`,
    );
    if (sampleNoUws.length) console.log(sampleNoUws.join("\n"));
  }

  // ── C1  uws vs predict (느림, opt-in) ─────────────────────────────────
  if (WITH_PREDICT) {
    console.log("· C1 uws.status vs predict(재판정 엔진)… [느림]");
    let mismatch = 0;
    let checked = 0;
    const users = new Set<string>();
    const samples: string[] = [];
    let processed = 0;
    for (const uid of userIds) {
      const org = orgByUser.get(uid) ?? null;
      for (const r of uwsByUser.get(uid) ?? []) {
        if (r.status !== "success" && r.status !== "fail") continue;
        const weekId = weekIdByStart.get(r.start);
        if (!weekId) continue;
        checked++;
        const pred = await predictWeekStatusForUser({ userId: uid, weekId, organizationSlug: org, now });
        if (pred.skipped || !pred.targetStatus) continue;
        if (pred.targetStatus !== r.status) {
          mismatch++;
          users.add(uid);
          affectedUsersGlobal.add(uid);
          if (samples.length < SAMPLES)
            samples.push(`    ${nm(uid)}  ${r.start}  uws=${r.status} → predict=${pred.targetStatus}`);
        }
      }
      if (++processed % 25 === 0) console.log(`    …${processed}/${userIds.length} (누적 ${mismatch})`);
    }
    summary.push({ code: "C1", label: "uws vs predict", checked, mismatch, users: users.size });
    if (samples.length) console.log(samples.join("\n"));
  } else {
    console.log("· C1 (uws vs predict) 건너뜀 — --with-predict 로 활성화");
  }

  // ── 요약 ────────────────────────────────────────────────────────────────
  console.log(`\n═══ 요약 (org=${ORG_FILTER ?? "전체"}) ═══`);
  console.table(
    summary.map((s) => ({
      code: s.code,
      검사항목: s.label,
      검사건수: s.checked,
      불일치: s.mismatch,
      비율: pct(s.mismatch, s.checked),
      영향유저: s.users,
    })),
  );
  console.log(`총 영향 유저(중복 제거): ${affectedUsersGlobal.size} / 대상 ${userIds.length}`);
  console.log(
    `\n※ 미구현 클래스(별도 deep pass 필요): C3/C4 성공↔target, C5 성공인데 A/B 없음, C7 2차허용인데 강화≠성공.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
