/**
 * 진단(read-only): growth_status='graduated' 사용자 vs 조직별 졸업 기준 충족 여부.
 *
 *   npx tsx --env-file=.env.local scripts/diag-graduated-testers-threshold.ts
 *
 * 확인 항목:
 *   1) graduated 전수 — 테스터(test_user_markers) / 실사용자 구분
 *   2) 테스터별: org / 졸업임계 / uws 기반 success(전환제외) / growth_stats 캐시 /
 *      표시 레이어 a·h (getGrowthIndicatorsInternal, snapshot-first)
 *   3) weeks 테이블 가용 활동주차 수 (전체 + end_date<today) — top-up 가능성 판단
 *   4) graduating 테스터도 참고 출력
 *
 * DB 변경 없음.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const OUT_PATH = "claudedocs/diag-graduated-testers-threshold-20260605.json";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const { GRADUATION_THRESHOLDS } = await import("@/lib/pointLabels");
  const { isTransitionWeekStart } = await import("@/lib/seasonCalendar");
  const { isSeasonRuleRestForWeekStart, fetchActiveRestPeriods } = await import(
    "@/lib/officialRestPeriodsData"
  );
  const { matchOfficialRestPeriods } = await import(
    "@/lib/officialRestPeriodsTypes"
  );
  const { getGrowthIndicatorsInternal } = await import(
    "@/lib/cluster3GrowthData"
  );

  // ── 0. 테스터 / graduated·graduating 프로필 ────────────────────────
  const [markers, gradProfiles] = await Promise.all([
    pageAll<{ user_id: string }>("test_user_markers", "user_id", undefined, "user_id"),
    pageAll<{
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
      growth_status: string | null;
      activity_started_at: string | null;
      activity_ended_at: string | null;
    }>(
      "user_profiles",
      "user_id,display_name,organization_slug,growth_status,activity_started_at,activity_ended_at",
      (q) => q.in("growth_status", ["graduated", "graduating"]),
      "user_id",
    ),
  ]);
  const testerIds = new Set(markers.map((m) => m.user_id));
  console.log(`테스터 마커: ${testerIds.size}명 | graduated/graduating 프로필: ${gradProfiles.length}명`);

  const graduatedTesters = gradProfiles.filter(
    (p) => p.growth_status === "graduated" && testerIds.has(p.user_id),
  );
  const graduatedReal = gradProfiles.filter(
    (p) => p.growth_status === "graduated" && !testerIds.has(p.user_id),
  );
  const graduatingTesters = gradProfiles.filter(
    (p) => p.growth_status === "graduating" && testerIds.has(p.user_id),
  );
  console.log(
    `graduated 테스터: ${graduatedTesters.length} | graduated 실사용자(불변·참고): ${graduatedReal.length} | graduating 테스터(참고): ${graduatingTesters.length}`,
  );
  for (const p of graduatedReal) {
    console.log(`  [실사용자 graduated — 절대 불변] ${p.display_name} (${p.user_id}) org=${p.organization_slug}`);
  }

  // ── 1. weeks 가용 활동주차 (top-up 가능성) ──────────────────────────
  const todayIso = new Date().toISOString().slice(0, 10);
  const [weeks, restPeriods] = await Promise.all([
    pageAll<{
      id: string;
      start_date: string;
      end_date: string | null;
      season_key: string | null;
      week_number: number | null;
    }>("weeks", "id,start_date,end_date,season_key,week_number", undefined, "start_date"),
    fetchActiveRestPeriods(),
  ]);
  const classify = (w: { start_date: string; end_date: string | null }) => {
    if (isTransitionWeekStart(w.start_date)) return "transition";
    const endDate = w.end_date ?? w.start_date;
    const rest =
      isSeasonRuleRestForWeekStart(w.start_date) ||
      matchOfficialRestPeriods({ startDate: w.start_date, endDate }, restPeriods).length > 0;
    return rest ? "rest" : "active";
  };
  const weekInfo = weeks.map((w) => ({
    ...w,
    cls: classify(w),
    elapsed: (w.end_date ?? w.start_date) < todayIso,
  }));
  const activeAll = weekInfo.filter((w) => w.cls === "active");
  const activeElapsed = activeAll.filter((w) => w.elapsed);
  console.log(
    `\nweeks 전수: ${weeks.length} (min=${weeks[0]?.start_date} max=${weeks[weeks.length - 1]?.start_date})`,
  );
  console.log(
    `활동주차: 전체 ${activeAll.length} | 종료(end<${todayIso}) ${activeElapsed.length} — 이 값이 success top-up 상한`,
  );
  console.log(`활동·종료 주차 범위: ${activeElapsed[0]?.start_date} ~ ${activeElapsed[activeElapsed.length - 1]?.start_date}`);

  // ── 2. graduated 테스터별 지표 ──────────────────────────────────────
  const targetIds = graduatedTesters.map((p) => p.user_id);
  const uwsByUser = new Map<string, { status: string; week_start_date: string }[]>();
  for (const c of chunk(targetIds, 100)) {
    const rows = await pageAll<{ user_id: string; status: string; week_start_date: string }>(
      "user_week_statuses",
      "user_id,status,week_start_date",
      (q) => q.in("user_id", c),
    );
    for (const r of rows) {
      if (!uwsByUser.has(r.user_id)) uwsByUser.set(r.user_id, []);
      uwsByUser.get(r.user_id)!.push(r);
    }
  }
  const gsRows = targetIds.length
    ? await pageAll<{ user_id: string; approved_weeks: number | null; cumulative_weeks: number | null }>(
        "user_growth_stats",
        "user_id,approved_weeks,cumulative_weeks",
        (q) => q.in("user_id", targetIds),
        "user_id",
      )
    : [];
  const gsById = new Map(gsRows.map((r) => [r.user_id, r]));

  type Row = {
    userId: string;
    name: string | null;
    org: string | null;
    threshold: number | null;
    uwsSuccess: number;
    uwsTotal: number;
    cacheApproved: number | null;
    cacheCumulative: number | null;
    displayA: number | null;
    displayH: number | null;
    displayEligible: boolean | null;
    displayKey: string | null;
    cardSource: string | null;
    activityStartedAt: string | null;
    activityEndedAt: string | null;
    meets: boolean | null;
  };
  const report: Row[] = [];

  for (const p of graduatedTesters) {
    const uws = (uwsByUser.get(p.user_id) ?? []).filter(
      (r) => !isTransitionWeekStart(r.week_start_date),
    );
    const uwsSuccess = uws.filter((r) => r.status === "success").length;
    const gs = gsById.get(p.user_id);
    const thr =
      (GRADUATION_THRESHOLDS as Record<string, number>)[p.organization_slug ?? ""] ?? null;

    let displayA: number | null = null;
    let displayH: number | null = null;
    let displayEligible: boolean | null = null;
    let displayKey: string | null = null;
    try {
      const ind = await getGrowthIndicatorsInternal(p.user_id);
      displayA = ind.period.a;
      displayH = ind.period.h;
      displayEligible = ind._debug.graduationEligible;
      displayKey = ind.process.growthDisplayKey;
    } catch (e) {
      console.warn(`  getGrowthIndicatorsInternal 실패(${p.user_id}): ${(e as Error).message}`);
    }

    report.push({
      userId: p.user_id,
      name: p.display_name,
      org: p.organization_slug,
      threshold: thr,
      uwsSuccess,
      uwsTotal: uws.length,
      cacheApproved: gs?.approved_weeks ?? null,
      cacheCumulative: gs?.cumulative_weeks ?? null,
      displayA,
      displayH,
      displayEligible,
      displayKey,
      cardSource: null,
      activityStartedAt: p.activity_started_at,
      activityEndedAt: p.activity_ended_at,
      meets: thr !== null && displayA !== null ? displayA >= thr : null,
    });
  }

  report.sort((a, b) => (a.org ?? "").localeCompare(b.org ?? "") || (a.name ?? "").localeCompare(b.name ?? ""));
  console.log("\n=== graduated 테스터 상세 (org | 이름 | a표시/uws성공/캐시 | 임계 | 충족) ===");
  for (const r of report) {
    const mark = r.meets === true ? "✓" : r.meets === false ? "✗" : "?";
    console.log(
      `${mark} [${r.org}] ${r.name} a=${r.displayA} h=${r.displayH} uws=${r.uwsSuccess}/${r.uwsTotal} cache=${r.cacheApproved}/${r.cacheCumulative} thr=${r.threshold} key=${r.displayKey} started=${r.activityStartedAt?.slice(0, 10)}`,
    );
  }

  const unmet = report.filter((r) => r.meets === false);
  console.log(`\n기준 미충족 graduated 테스터: ${unmet.length}/${report.length}명`);
  const byOrg = new Map<string, Row[]>();
  for (const r of report) {
    const k = r.org ?? "unknown";
    if (!byOrg.has(k)) byOrg.set(k, []);
    byOrg.get(k)!.push(r);
  }
  for (const [org, rows] of byOrg) {
    const thr = rows[0].threshold;
    console.log(
      `  [${org}] 임계=${thr} | graduated=${rows.length} | 미충족=${rows.filter((r) => r.meets === false).length} | 가용 활동주차(종료)=${activeElapsed.length} → top-up ${thr !== null && activeElapsed.length >= thr ? "가능" : "불가(강등 필요)"}`,
    );
  }

  // graduating 테스터 참고 (이번 보정 범위 밖이지만 기준 역전 여부 확인)
  if (graduatingTesters.length) {
    console.log(`\n(참고) graduating 테스터 ${graduatingTesters.length}명: ${graduatingTesters.map((p) => `${p.display_name}(${p.organization_slug})`).join(", ")}`);
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        todayIso,
        activeWeeksTotal: activeAll.length,
        activeWeeksElapsed: activeElapsed.length,
        activeElapsedStarts: activeElapsed.map((w) => w.start_date),
        graduatedReal: graduatedReal.map((p) => ({ userId: p.user_id, name: p.display_name, org: p.organization_slug })),
        graduatedTesters: report,
        graduatingTesters: graduatingTesters.map((p) => ({ userId: p.user_id, name: p.display_name, org: p.organization_slug })),
      },
      null,
      2,
    ),
  );
  console.log(`\n리포트 저장: ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
