/**
 * encre/phalanx 테스터 60명 — org_week_thresholds 기준 B8류 정합 재작업 (stale 처리 방향 (a)).
 *
 *   npx tsx --env-file=.env.local scripts/reseed-tester-org-thresholds.ts            # dry-run (쓰기 0)
 *   npx tsx --env-file=.env.local scripts/reseed-tester-org-thresholds.ts --apply    # 적용 + recalc + snapshot
 *
 * 배경: hrdb/olympus threshold 백필로 encre/phalanx 테스터의 read-time 판정이 자기 org 값으로
 *   전환 — 기존 시드는 공통(weeks=ORANKE 달력) 기준 정렬이라 mismatch 발생
 *   (census: aShift 43 · bThr0 10 · anomaly 0 — claudedocs/owt-tester-mismatch-census-20260607.json).
 *
 * 재정합 규칙 (B8 reseed-tester-check-37 미러 — 케이스 의도 보존):
 *   A-shift: uws=success ∧ 평점 ok ∧ points ∈ [T_old, T_new) → uwp.points += (T_new − T_old)
 *            (분포 평행이동 — 케이스 A "주차 성공" 유지, uws 무접촉)
 *   B-thr0 : uws=fail ∧ 평점 ok ∧ T_new=0 → 게이트 불실패(소스 의미론: 기준 0 = 전원 통과)
 *            → uws.status fail→success (그 주차의 케이스 B 의도는 신 SoT 에서 표현 불가)
 *   분류 밖 mismatch → anomaly: apply 중단 (fail-closed).
 *
 * 안전 계약 (B8 동일):
 *   - 대상 = checks_migrated 보유 ∧ org∈{encre,phalanx} ∧ test_user_markers 등재 (3중 교집합).
 *   - 실사용자·oranke 테스터 30명 절대 무접촉 — 적용 전/후 (비대상 전원) uwp·uws fingerprint 동일 검증.
 *   - 행 단위 가드 갱신 (uwp: id+points=구값 / uws: user+week_start_date+status='fail').
 *   - run log 에 구값 기록 (롤백 가능).
 *   - 적용 후: 대상 사용자 recalcUserGrowthStats(uws 변경자) → 60명 전원 snapshot 재계산
 *     → mismatch 재조사 = 0 검증.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  fetchLegacyUnifiedExperienceByWeek,
  reduceLegacyUnifiedVerdict,
} from "@/lib/lineAvailability";
import { EXPERIENCE_RATING_FAIL_THRESHOLD } from "@/lib/cluster4Enhancement";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { OrganizationSlug } from "@/lib/organizations";

const APPLY = process.argv.includes("--apply");
const OUT = `claudedocs/reseed-tester-org-thresholds-${APPLY ? "apply" : "dryrun"}-20260607.json`;
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type UwpRow = { id: string; user_id: string; year: number; week_number: number; points: number; checks_migrated: boolean };
type UwsRow = { id?: string; user_id: string; week_start_date: string; status: string };

// 비대상(실사용자 + oranke 테스터 포함 전원) uwp·uws fingerprint — 무접촉 증명.
async function nonTargetFingerprint(targetIds: Set<string>): Promise<string> {
  const uwp = (await fetchAll<UwpRow>("user_weekly_points", "id,user_id,year,week_number,points,checks_migrated", "id"))
    .filter((r) => !targetIds.has(r.user_id));
  const uws = (await fetchAll<UwsRow>("user_week_statuses", "user_id,week_start_date,status", "user_id"))
    .filter((r) => !targetIds.has(r.user_id));
  return sha1(JSON.stringify(uwp) + "|" + JSON.stringify(uws));
}

async function main() {
  // ── 대상 60명 (3중 교집합) ──
  const enforced = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("user_id")
      .eq("checks_migrated", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { user_id: string }[]) enforced.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  const markers = new Set(
    (await fetchAll<{ user_id: string }>("test_user_markers", "user_id", "user_id")).map((m) => m.user_id),
  );
  const targets: Array<{ user_id: string; org: OrganizationSlug; name: string | null }> = [];
  for (const uid of enforced) {
    const { data: p } = await sb
      .from("user_profiles")
      .select("organization_slug,display_name")
      .eq("user_id", uid)
      .maybeSingle();
    const prof = p as { organization_slug: string | null; display_name: string | null } | null;
    const org = prof?.organization_slug;
    if ((org === "encre" || org === "phalanx") && markers.has(uid)) {
      if (!/t/i.test(prof?.display_name ?? "")) throw new Error(`테스터 이름 규약 위반: ${uid}`);
      targets.push({ user_id: uid, org, name: prof?.display_name ?? null });
    }
  }
  if (targets.length !== 60) throw new Error(`대상 ${targets.length}명 ≠ 60명 — 전제 변동, 중단`);
  const targetIds = new Set(targets.map((t) => t.user_id));

  const fpBefore = await nonTargetFingerprint(targetIds);

  // ── 주차 메타 ──
  type WeekRow = { id: string; start_date: string | null; iso_year: number | null; iso_week: number | null; season_key: string | null; week_number: number | null };
  const weeks = await fetchAll<WeekRow>("weeks", "id,start_date,iso_year,iso_week,season_key,week_number", "id");
  const legacyWeeks = weeks.filter((w) => w.start_date && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const weekById = new Map(legacyWeeks.map((w) => [w.id, w]));
  const legacyIds = legacyWeeks.map((w) => w.id);

  // ── mismatch 분류 → 작업 목록 ──
  type AShift = { user_id: string; name: string | null; org: string; week_label: string; uwp_id: string; old_points: number; new_points: number; t_old: number; t_new: number };
  type BFlip = { user_id: string; name: string | null; org: string; week_label: string; week_start_date: string; old_status: "fail"; new_status: "success" };
  const aShifts: AShift[] = [];
  const bFlips: BFlip[] = [];
  const anomalies: Array<Record<string, unknown>> = [];
  const now = Date.now();
  let processed = 0;
  for (const t of targets) {
    const { data: uwsData } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", t.user_id)
      .order("week_start_date", { ascending: true })
      .range(0, 4999);
    const uwsByStart = new Map(
      ((uwsData ?? []) as { week_start_date: string; status: string }[]).map((r) => [r.week_start_date, r.status]),
    );
    const { data: uwpData } = await sb
      .from("user_weekly_points")
      .select("id,user_id,year,week_number,points,checks_migrated")
      .eq("user_id", t.user_id)
      .order("id", { ascending: true })
      .range(0, 4999);
    const uwpByIso = new Map(
      ((uwpData ?? []) as UwpRow[]).map((r) => [`${r.year}-${r.week_number}`, r]),
    );
    const [oldStates, newStates] = await Promise.all([
      fetchLegacyUnifiedExperienceByWeek(t.user_id, legacyIds, now, { organizationSlug: null }),
      fetchLegacyUnifiedExperienceByWeek(t.user_id, legacyIds, now, { organizationSlug: t.org }),
    ]);
    for (const [weekId, ns] of newStates) {
      const os = oldStates.get(weekId);
      const w = weekById.get(weekId);
      if (!os || !w || !w.start_date) continue;
      const uws = uwsByStart.get(w.start_date);
      if (uws !== "success" && uws !== "fail") continue;
      if (!ns.checkDataMigrated) continue;
      const verdictNew = reduceLegacyUnifiedVerdict(ns).status;
      const aligned = (uws === "success" && verdictNew !== "fail") || (uws === "fail" && verdictNew === "fail");
      if (aligned) continue;
      const ratingOk = !(ns.hasTarget && ns.rating != null && ns.rating <= EXPERIENCE_RATING_FAIL_THRESHOLD);
      const tOld = os.checkThreshold;
      const tNew = ns.checkThreshold;
      const label = `${w.season_key} W${w.week_number} (${w.start_date})`;
      if (ratingOk && uws === "success" && ns.checkCount >= tOld && ns.checkCount < tNew) {
        const uwp = w.iso_year != null && w.iso_week != null ? uwpByIso.get(`${w.iso_year}-${w.iso_week}`) : undefined;
        if (!uwp || !uwp.checks_migrated) {
          anomalies.push({ user: t.user_id, week: label, why: "uwp 행 부재/비이관 — A-shift 불가" });
          continue;
        }
        aShifts.push({
          user_id: t.user_id, name: t.name, org: t.org, week_label: label,
          uwp_id: uwp.id, old_points: uwp.points, new_points: uwp.points + (tNew - tOld), t_old: tOld, t_new: tNew,
        });
      } else if (ratingOk && uws === "fail" && tNew === 0) {
        bFlips.push({
          user_id: t.user_id, name: t.name, org: t.org, week_label: label,
          week_start_date: w.start_date, old_status: "fail", new_status: "success",
        });
      } else {
        anomalies.push({ user: t.user_id, week: label, uws, verdictNew, tOld, tNew, points: ns.checkCount, rating: ns.rating, why: "분류 규칙 밖" });
      }
    }
    processed++;
    if (processed % 20 === 0) console.log(`  …분류 ${processed}/${targets.length}`);
  }

  console.log(`분류: aShift=${aShifts.length} bFlip(thr0)=${bFlips.length} anomaly=${anomalies.length}`);
  if (anomalies.length > 0) {
    writeFileSync(OUT, JSON.stringify({ blocked: true, anomalies, aShifts, bFlips }, null, 2));
    console.error("anomaly 존재 — fail-closed 중단. →", OUT);
    process.exit(1);
  }

  // ── apply ──
  const applied = { aShift: 0, bFlip: 0, recalc: 0, snapshots: 0, errors: [] as string[] };
  if (APPLY) {
    for (const s of aShifts) {
      const { data, error } = await sb
        .from("user_weekly_points")
        .update({ points: s.new_points, updated_at: new Date().toISOString() })
        .eq("id", s.uwp_id)
        .eq("points", s.old_points) // 구값 가드
        .select("id");
      if (error || (data ?? []).length !== 1) {
        applied.errors.push(`aShift ${s.uwp_id}: ${error?.message ?? `rows=${(data ?? []).length}`}`);
      } else applied.aShift++;
    }
    for (const f of bFlips) {
      const { data, error } = await sb
        .from("user_week_statuses")
        .update({ status: "success", updated_at: new Date().toISOString() })
        .eq("user_id", f.user_id)
        .eq("week_start_date", f.week_start_date)
        .eq("status", "fail") // 구값 가드
        .select("user_id");
      if (error || (data ?? []).length !== 1) {
        applied.errors.push(`bFlip ${f.user_id}|${f.week_start_date}: ${error?.message ?? `rows=${(data ?? []).length}`}`);
      } else applied.bFlip++;
    }
    // uws writer 후 recalcUserGrowthStats 필수 (전환 제외 표준 집계)
    const recalcUsers = [...new Set(bFlips.map((f) => f.user_id))];
    for (const uid of recalcUsers) {
      try {
        await recalcUserGrowthStats(uid);
        applied.recalc++;
      } catch (e) {
        applied.errors.push(`recalc ${uid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 60명 전원 snapshot 재계산 (stale 해소 — 방향 (a))
    for (const t of targets) {
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(t.user_id);
        applied.snapshots++;
      } catch (e) {
        applied.errors.push(`snapshot ${t.user_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ── 무접촉 검증 ──
  const fpAfter = await nonTargetFingerprint(targetIds);
  const nonTargetUntouched = fpBefore === fpAfter;

  // ── 적용 후 mismatch 재조사 (apply 시) ──
  let postMismatch = -1;
  if (APPLY) {
    postMismatch = 0;
    for (const t of targets) {
      const { data: uwsData } = await sb
        .from("user_week_statuses")
        .select("week_start_date,status")
        .eq("user_id", t.user_id)
        .order("week_start_date", { ascending: true })
        .range(0, 4999);
      const uwsByStart = new Map(
        ((uwsData ?? []) as { week_start_date: string; status: string }[]).map((r) => [r.week_start_date, r.status]),
      );
      const states = await fetchLegacyUnifiedExperienceByWeek(t.user_id, legacyIds, Date.now(), {
        organizationSlug: t.org,
      });
      for (const [weekId, ns] of states) {
        const w = weekById.get(weekId);
        if (!w?.start_date || !ns.checkDataMigrated) continue;
        const uws = uwsByStart.get(w.start_date);
        if (uws !== "success" && uws !== "fail") continue;
        const v = reduceLegacyUnifiedVerdict(ns).status;
        const aligned = (uws === "success" && v !== "fail") || (uws === "fail" && v === "fail");
        if (!aligned) postMismatch++;
      }
    }
  }

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    targets: targets.length,
    plan: { aShift: aShifts.length, bFlipThr0: bFlips.length, anomalies: anomalies.length },
    applied: APPLY ? applied : null,
    nonTargetUntouched,
    nonTargetFingerprint: { before: fpBefore, after: fpAfter },
    postMismatch: APPLY ? postMismatch : null,
    targetsList: targets,
    aShifts,
    bFlips,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { mode: report.mode, plan: report.plan, applied: report.applied, nonTargetUntouched, postMismatch },
      null,
      2,
    ),
  );
  console.log("→", OUT);
  if (APPLY && (applied.errors.length > 0 || !nonTargetUntouched || postMismatch !== 0)) process.exit(1);
  if (!nonTargetUntouched) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
