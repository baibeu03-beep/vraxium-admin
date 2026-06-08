/**
 * 테스터 check 재시드 — check_threshold 37/35 기준 정렬 (B7 apply 와 분리된 독립 작업).
 *
 *   npx tsx --env-file=.env.local scripts/reseed-tester-check-37.ts            # dry-run (쓰기 0)
 *   npx tsx --env-file=.env.local scripts/reseed-tester-check-37.ts --apply    # 적용 + snapshot 재계산
 *
 * 배경: 기존 테스터 check 시드(legacy-check-case-seed-20260605)는 기준 30 전제 —
 *   B7 apply(threshold 37/35) 시 케이스 A(주차 성공) 중 points∈[30,신기준) 행이
 *   B(강화성공+주차실패)로 뒤집힘 (B8 실측 358 + 미공표 W13 일부).
 *
 * 재시드 규칙 (케이스 의도 보존):
 *   - 대상: test_user_markers 테스터 × b8AuditWeekSet 25주(=B7 threshold 세팅 주차) ×
 *     uwp.checks_migrated=true ∧ uws.status='success' ∧ 평점 ok(null|≥4) ∧ points∈[30, 신기준).
 *   - 액션: points += (신기준 − 30)  → [37,44)/[35,40) — 기존 분포 평행이동, 케이스 A 유지.
 *   - 케이스 B(uws=fail, points<30)·C/D(평점 fail)·신기준 이상 행: 무접촉 (의도 그대로).
 *   - uws: 변경 0행 (케이스 의도가 uws 에 이미 정렬되어 있음 — 수치만 기준 이동).
 *   - 감사 25주 밖 레거시 주차: threshold 미세팅(기본 30 유지) — 재시드 불필요, 무접촉.
 *
 * 안전 계약:
 *   - 실사용자 절대 무접촉: 대상 구성단계에서 test_user_markers 교집합 + 적용 전 단언 +
 *     적용 전/후 비테스터 uwp·uws 전행 fingerprint 동일 검증.
 *   - PMS 이관 데이터와 무관 (이관 전 — 테스터 시드 행만 수정).
 *   - 갱신은 행 단위 (id + points=구값 가드) — 행수 1 검증, run log 에 구값 기록(롤백 가능).
 *   - 적용 후: ① 신기준 재판정 flip=0 시뮬레이션 ② 대상 테스터 snapshot 재계산.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const PLAN_PATH = "claudedocs/backfill-seasons-weeks-dryrun-20260605.json";
const OUT_LOG = "claudedocs/reseed-tester-check-37-20260606.json";
const LEGACY_BASE_THRESHOLD = 30; // 기존 시드 전제 기준 (lib DEFAULT_WEEK_CHECK_THRESHOLD 와 동일)
const RATING_FAIL_MAX = 3;
const LEGACY_UNIFIED_LINE_NAME = "[통합] 주차 활동 내역";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function fetchAll<T>(
  table: string,
  select: string,
  applyFilters?: (q: any) => any,
  orderCol = "user_id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} select 실패: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

type UwpRow = {
  id: string;
  user_id: string;
  year: number;
  week_number: number;
  week_start_date: string;
  points: number;
  checks_migrated: boolean;
};
type UwsRow = { user_id: string; week_start_date: string; status: string };

// 비테스터 fingerprint — 실사용자 영향 0 검증 (uwp·uws 전행, 안정 정렬 직렬화)
async function nonTesterFingerprint(testers: Set<string>): Promise<string> {
  const uwp = await fetchAll<UwpRow>(
    "user_weekly_points",
    "id,user_id,year,week_number,week_start_date,points,checks_migrated",
    undefined,
    "id",
  );
  const uws = await fetchAll<{ id: string; user_id: string; week_start_date: string; status: string }>(
    "user_week_statuses",
    "id,user_id,week_start_date,status",
    undefined,
    "id",
  );
  const a = uwp.filter((r) => !testers.has(r.user_id)).map((r) => `${r.id}|${r.points}|${r.checks_migrated}`);
  const b = uws.filter((r) => !testers.has(r.user_id)).map((r) => `${r.id}|${r.status}`);
  return JSON.stringify({ uwpCount: a.length, uwsCount: b.length, uwp: a.sort(), uws: b.sort() });
}

async function main() {
  // ── 0. 감사 25주 (B7 threshold 세팅 대상 = 재시드 범위) ──
  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  const auditWeeks = plan.b8AuditWeekSet.weeks as {
    season_key: string;
    week_number: number;
    start_date: string;
    check_threshold: number;
  }[];
  if (auditWeeks.length !== 25) throw new Error(`audit set 25 기대, 실제 ${auditWeeks.length}`);
  const { data: liveWeeks, error: wErr } = await sb
    .from("weeks")
    .select("id,start_date,iso_year,iso_week")
    .in("start_date", auditWeeks.map((w) => w.start_date));
  if (wErr || !liveWeeks || liveWeeks.length !== 25) throw new Error(`라이브 weeks 매칭 실패 (${liveWeeks?.length ?? 0}/25)`);
  type WeekMeta = { weekId: string; start: string; isoKey: string; newThr: number; label: string };
  const weekByIso = new Map<string, WeekMeta>();
  const weekByStart = new Map<string, WeekMeta>();
  for (const aw of auditWeeks) {
    const lw = liveWeeks.find((w) => w.start_date === aw.start_date)!;
    const m: WeekMeta = {
      weekId: lw.id as string,
      start: aw.start_date,
      isoKey: `${lw.iso_year}-${lw.iso_week}`,
      newThr: aw.check_threshold,
      label: `${aw.season_key} W${aw.week_number}`,
    };
    weekByIso.set(m.isoKey, m);
    weekByStart.set(m.start, m);
  }

  // ── 1. 테스터 / uwp / uws / 평점 ──
  const testers = new Set(
    (await fetchAll<{ user_id: string }>("test_user_markers", "user_id")).map((r) => r.user_id),
  );
  console.log(`테스터(test_user_markers): ${testers.size}명`);

  const isoYears = [...new Set([...weekByIso.values()].map((w) => Number(w.isoKey.split("-")[0])))];
  const uwpRows = await fetchAll<UwpRow>(
    "user_weekly_points",
    "id,user_id,year,week_number,week_start_date,points,checks_migrated",
    (q) => q.in("year", isoYears),
  );
  const uwsRows = await fetchAll<UwsRow>(
    "user_week_statuses",
    "user_id,week_start_date,status",
    (q) => q.in("week_start_date", auditWeeks.map((w) => w.start_date)),
  );
  const uwsByUserStart = new Map(uwsRows.map((r) => [`${r.user_id}|${r.week_start_date}`, r.status]));

  // 평점 (통합 라인) — b8 스크립트와 동일 경로
  const { data: masterRow } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .limit(1)
    .maybeSingle();
  if (!masterRow?.id) throw new Error("통합 마스터 미발견");
  const { data: lineRows, error: lErr } = await sb
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "experience")
    .eq("experience_line_master_id", masterRow.id)
    .eq("is_active", true);
  if (lErr) throw new Error(`unified lines 실패: ${lErr.message}`);
  const auditWeekIds = [...weekByStart.values()].map((w) => w.weekId);
  const targets: { id: string; target_user_id: string; week_id: string }[] = [];
  for (const lc of chunk((lineRows ?? []).map((l) => l.id as string), 50)) {
    targets.push(
      ...(await fetchAll<{ id: string; target_user_id: string; week_id: string }>(
        "cluster4_line_targets",
        "id,target_user_id,week_id",
        (q) => q.eq("target_mode", "user").in("line_id", lc).in("week_id", auditWeekIds),
        "id",
      )),
    );
  }
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const ratingByUserWeekId = new Map<string, number>();
  for (const tc of chunk([...targetById.keys()], 200)) {
    const { data: evals, error: eErr } = await sb
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,user_id,rating")
      .in("line_target_id", tc);
    if (eErr) throw new Error(`evaluations 실패: ${eErr.message}`);
    for (const e of evals ?? []) {
      const t = targetById.get(e.line_target_id as string);
      if (t) ratingByUserWeekId.set(`${e.user_id}|${t.week_id}`, e.rating as number);
    }
  }

  // ── 2. 대상 산출 — 테스터 ∧ enforced ∧ uws success ∧ 평점 ok ∧ points∈[30,신기준) ──
  type Target = {
    uwpId: string;
    userId: string;
    week: string;
    weekStart: string;
    oldPoints: number;
    newPoints: number;
    newThr: number;
  };
  const reseedTargets: Target[] = [];
  let skippedNonSuccess = 0,
    skippedRatingFail = 0,
    alreadyOk = 0;
  for (const r of uwpRows) {
    const w = weekByIso.get(`${r.year}-${r.week_number}`);
    if (!w) continue; // 감사 25주 밖
    if (!testers.has(r.user_id)) continue; // 실사용자 절대 무접촉 (구성단계 필터)
    if (r.checks_migrated !== true) continue; // 이관 플래그 행만 (계약)
    const uwsStatus = uwsByUserStart.get(`${r.user_id}|${w.start}`);
    if (uwsStatus !== "success") {
      skippedNonSuccess++;
      continue; // 케이스 B/C/D 또는 휴식 — 의도 보존
    }
    const rating = ratingByUserWeekId.get(`${r.user_id}|${w.weekId}`) ?? null;
    if (rating != null && rating <= RATING_FAIL_MAX) {
      skippedRatingFail++;
      continue; // 평점 fail — 주차 실패 의도 (check 무관)
    }
    if (r.points >= w.newThr) {
      alreadyOk++;
      continue; // 신기준에서도 성공 — 무접촉
    }
    if (r.points < LEGACY_BASE_THRESHOLD) {
      // uws=success 인데 points<30 — 시드 계약 위반 데이터 (존재하면 안 됨: B8 alreadyDemoted=0)
      throw new Error(`계약 위반: ${r.user_id.slice(0, 8)} ${w.label} uws=success 인데 points=${r.points}<30`);
    }
    reseedTargets.push({
      uwpId: r.id,
      userId: r.user_id,
      week: w.label,
      weekStart: w.start,
      oldPoints: r.points,
      newPoints: r.points + (w.newThr - LEGACY_BASE_THRESHOLD), // 분포 평행이동 (+7 / W9 +5)
      newThr: w.newThr,
    });
  }
  // 안전 단언: 대상 전원 테스터
  for (const t of reseedTargets) {
    if (!testers.has(t.userId)) throw new Error(`단언 실패: 비테스터 대상 포함 ${t.userId}`);
  }
  const affectedUsers = [...new Set(reseedTargets.map((t) => t.userId))];

  const byWeek = new Map<string, number>();
  for (const t of reseedTargets) byWeek.set(t.week, (byWeek.get(t.week) ?? 0) + 1);

  console.log("══ 테스터 check 재시드 (37/35 기준) ══");
  console.log(`수정 대상: 테스터 ${affectedUsers.length}명 / uwp ${reseedTargets.length}행 / uws 0행(의도 보존 — 변경 불필요)`);
  console.log(`스킵: 비success ${skippedNonSuccess} · 평점fail ${skippedRatingFail} · 신기준 이미 충족 ${alreadyOk}`);
  console.log("주차별:", [...byWeek.entries()].sort().map(([k, n]) => `${k}:${n}`).join(" "));

  if (!APPLY) {
    console.log("\nDRY-RUN — 변경 없음. 적용하려면 --apply.");
    writeFileSync(
      OUT_LOG.replace(".json", "-dryrun.json"),
      JSON.stringify({ mode: "dry-run", targetUsers: affectedUsers.length, targetRows: reseedTargets.length, targets: reseedTargets }, null, 1),
    );
    return;
  }

  // ── 3. APPLY ──
  console.log("\n[3-0] 비테스터 fingerprint (적용 전) 채취…");
  const fpBefore = await nonTesterFingerprint(testers);

  const runLog: Record<string, unknown> = {
    appliedAt: new Date().toISOString(),
    applied: true,
    targetUsers: affectedUsers.length,
    targetRows: reseedTargets.length,
    uwsRowsChanged: 0,
    updated: [] as unknown[],
  };
  let updated = 0;
  for (const t of reseedTargets) {
    // id + 구값 가드 — 동시 변경/재실행 시 행수 0 으로 안전 중단
    const { data, error } = await sb
      .from("user_weekly_points")
      .update({ points: t.newPoints })
      .eq("id", t.uwpId)
      .eq("points", t.oldPoints)
      .select("id");
    if (error) {
      writeFileSync(OUT_LOG, JSON.stringify(runLog, null, 1));
      throw new Error(`갱신 실패 ${t.userId.slice(0, 8)} ${t.week}: ${error.message}`);
    }
    if ((data ?? []).length !== 1) {
      writeFileSync(OUT_LOG, JSON.stringify(runLog, null, 1));
      throw new Error(`갱신 행수 ${(data ?? []).length} (기대 1) — ${t.userId.slice(0, 8)} ${t.week} drift`);
    }
    (runLog.updated as unknown[]).push(t);
    updated++;
    if (updated % 50 === 0) console.log(`  ...${updated}/${reseedTargets.length}`);
  }
  writeFileSync(OUT_LOG, JSON.stringify(runLog, null, 1));
  console.log(`[3-1] uwp 갱신 ${updated}/${reseedTargets.length} (uws 변경 0행)`);

  // ── 4. 신기준 재판정 시뮬레이션 — flip 0 검증 ──
  const uwpAfter = await fetchAll<UwpRow>(
    "user_weekly_points",
    "id,user_id,year,week_number,points,checks_migrated",
    (q) => q.in("year", isoYears),
  );
  let flips = 0;
  for (const r of uwpAfter) {
    const w = weekByIso.get(`${r.year}-${r.week_number}`);
    if (!w || !testers.has(r.user_id) || r.checks_migrated !== true) continue;
    if (uwsByUserStart.get(`${r.user_id}|${w.start}`) !== "success") continue;
    const rating = ratingByUserWeekId.get(`${r.user_id}|${w.weekId}`) ?? null;
    if (rating != null && rating <= RATING_FAIL_MAX) continue;
    if (r.points >= LEGACY_BASE_THRESHOLD && r.points < w.newThr) flips++;
  }
  console.log(`[4] 신기준(37/35) 재판정 시뮬레이션: flip ${flips}건 ${flips === 0 ? "✅" : "❌"}`);
  runLog.flipSimulationAfter = flips;
  if (flips !== 0) throw new Error("flip 0 검증 실패");

  // ── 5. 실사용자 영향 0 — fingerprint 대조 ──
  const fpAfter = await nonTesterFingerprint(testers);
  const realUntouched = fpBefore === fpAfter;
  console.log(`[5] 비테스터 uwp·uws fingerprint 동일: ${realUntouched ? "✅" : "❌"}`);
  runLog.nonTesterFingerprintEqual = realUntouched;
  if (!realUntouched) throw new Error("실사용자 영향 검출 — 즉시 확인 필요");

  // ── 6. snapshot 재계산 (영향 테스터만) ──
  console.log(`[6] snapshot 재계산 ${affectedUsers.length}명…`);
  let snapOk = 0;
  const snapFailed: string[] = [];
  for (const uid of affectedUsers) {
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      snapOk++;
      if (snapOk % 10 === 0) console.log(`  ...${snapOk}/${affectedUsers.length}`);
    } catch (e) {
      snapFailed.push(uid);
      console.error(`  ❌ ${uid}: ${(e as Error).message}`);
    }
  }
  runLog.snapshotRecompute = { users: affectedUsers.length, ok: snapOk, failed: snapFailed };
  writeFileSync(OUT_LOG, JSON.stringify(runLog, null, 1));
  console.log(`[6] snapshot ${snapOk}/${affectedUsers.length}${snapFailed.length ? ` (실패 ${snapFailed.length})` : ""}`);

  console.log(`\n✅ 재시드 완료 — run log: ${OUT_LOG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
