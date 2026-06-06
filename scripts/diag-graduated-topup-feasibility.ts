/**
 * 진단(read-only): graduated 유지 top-up 실행 계획 조사 — 2026-06-05 2차.
 *
 *   npx tsx --env-file=.env.local scripts/diag-graduated-topup-feasibility.ts
 *
 * 목적: encre/phalanx 더미 6명(현재 active 강등 상태)을 "주차 데이터 추가로 30주 충족 +
 *   graduated 복원"하기 위한 사전 조사. DB 변경 없음.
 *
 * 조사 항목:
 *   1) 과거 휴식(공식) 주차 재고 — 공표 여부(공표 안 된 주차는 success 로 안 집계됨)
 *   2) 현재 a=26 인 이유(미공표 활동 주차 식별)
 *   3) 휴식 주차의 통합 라인 개설 여부(미개설이어야 verdict=not_applicable → uws 보존)
 *   4) 대상 6명의 휴식 주차 uws 행 존재/상태
 *   5) 대상 6명의 휴식 주차 user_weekly_points 행(없어야 check 게이트 무관 — 기존 패턴 일치)
 *   6) 후보 선택 시뮬레이션: 최근 공표 휴식 주차 4개 flip → 예상 a
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const OUT_PATH = "claudedocs/diag-graduated-topup-feasibility-20260605.json";

// 강등 6명 (claudedocs/graduated-tester-threshold-fix-20260605.json 의 demotes)
const TARGETS = [
  { name: "T윤도현", uid: "bf3b4305-751a-49e3-88ad-95a20e5c4dad", org: "encre", endedBefore: null },
  { name: "T임다인", uid: "42864260-e4ea-4150-a87f-cff545b02af1", org: "encre", endedBefore: "2026-05-19T00:00:00+00:00" },
  { name: "T장유준", uid: "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", org: "encre", endedBefore: "2026-05-12T00:00:00+00:00" },
  { name: "T윤태현", uid: "05ff6b96-b3e7-4050-97f1-080633f183d3", org: "phalanx", endedBefore: null },
  { name: "T임건우", uid: "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", org: "phalanx", endedBefore: "2026-05-19T00:00:00+00:00" },
  { name: "T장시현", uid: "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", org: "phalanx", endedBefore: "2026-05-12T00:00:00+00:00" },
] as const;

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
  const { isTransitionWeekStart } = await import("@/lib/seasonCalendar");
  const { isSeasonRuleRestForWeekStart, fetchActiveRestPeriods } = await import(
    "@/lib/officialRestPeriodsData"
  );
  const { matchOfficialRestPeriods } = await import("@/lib/officialRestPeriodsTypes");
  const { LEGACY_UNIFIED_LINE_NAME } = await import("@/lib/lineAvailability");

  const todayIso = new Date().toISOString().slice(0, 10);
  const [weeks, restPeriods] = await Promise.all([
    pageAll<{
      id: string;
      start_date: string;
      end_date: string | null;
      season_key: string | null;
      week_number: number | null;
      is_official_rest: boolean;
      result_published_at: string | null;
      iso_year: number | null;
      iso_week: number | null;
    }>(
      "weeks",
      "id,start_date,end_date,season_key,week_number,is_official_rest,result_published_at,iso_year,iso_week",
      undefined,
      "start_date",
    ),
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
  const winfo = weeks.map((w) => ({
    ...w,
    cls: classify(w),
    elapsed: (w.end_date ?? w.start_date) < todayIso,
  }));

  // ── 1) 휴식 주차 재고 (과거·공표 여부) ────────────────────────────────
  const restElapsed = winfo.filter((w) => w.cls === "rest" && w.elapsed);
  console.log("=== 1) 과거 휴식(공식) 주차 재고 ===");
  for (const w of restElapsed) {
    console.log(
      `  ${w.start_date} [${w.season_key} W${w.week_number}] published=${w.result_published_at ? "Y" : "N"} db_flag=${w.is_official_rest}`,
    );
  }
  const restPublished = restElapsed.filter((w) => w.result_published_at);
  console.log(
    `휴식 주차: 과거 ${restElapsed.length} | 공표 완료(=success 집계 가능) ${restPublished.length}`,
  );

  // ── 2) a=26 인 이유 — 미공표 활동 주차 ─────────────────────────────────
  console.log("\n=== 2) 활동 주차 중 미공표(=tallying, a 미집계) ===");
  const activeUnpublished = winfo.filter(
    (w) => w.cls === "active" && w.elapsed && !w.result_published_at,
  );
  for (const w of activeUnpublished) {
    console.log(`  ${w.start_date} [${w.season_key} W${w.week_number}] — 공표 시 a +1 (전 사용자 공통)`);
  }

  // ── 3) 휴식 주차 통합 라인 개설 여부 ──────────────────────────────────
  console.log("\n=== 3) 휴식 주차의 [통합] 라인 개설 여부 (미개설=verdict not_applicable 기대) ===");
  const { data: master } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .maybeSingle();
  const masterId = (master as any)?.id ?? null;
  const restWeekIds = new Set(restElapsed.map((w) => w.id));
  let linesOnRest: { id: string; week_id: string }[] = [];
  if (masterId) {
    const lines = await pageAll<{ id: string; week_id: string }>(
      "cluster4_lines",
      "id,week_id",
      (q) => q.eq("experience_line_master_id", masterId),
    );
    linesOnRest = lines.filter((l) => restWeekIds.has(l.week_id));
  }
  console.log(`  통합 마스터=${masterId} | 휴식 주차 위 통합 라인: ${linesOnRest.length}개 (0 기대)`);

  // ── 4) 대상 6명 uws 행 (휴식 주차) ───────────────────────────────────
  console.log("\n=== 4) 대상 6명 — 휴식 주차 uws 상태 ===");
  const weekByStart = new Map(winfo.map((w) => [w.start_date, w]));
  const uwsByUser = new Map<string, Map<string, { id: string; status: string; ovr: boolean }>>();
  for (const t of TARGETS) {
    const rows = await pageAll<{
      id: string;
      week_start_date: string;
      status: string;
      is_official_rest_override: boolean;
    }>(
      "user_week_statuses",
      "id,week_start_date,status,is_official_rest_override",
      (q) => q.eq("user_id", t.uid),
    );
    const m = new Map(
      rows.map((r) => [r.week_start_date, { id: r.id, status: r.status, ovr: r.is_official_rest_override }]),
    );
    uwsByUser.set(t.uid, m);
    const restStates = restElapsed.map((w) => m.get(w.start_date)?.status ?? "(행 없음)");
    const counts = restStates.reduce<Record<string, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  ${t.name}: 휴식주차 uws ${JSON.stringify(counts)}`);
  }

  // ── 5) 휴식 주차 user_weekly_points (없음 기대 — check 게이트/품계 캐시 무관) ──
  console.log("\n=== 5) 휴식 주차 user_weekly_points 행 ===");
  const restIsoKeys = new Set(
    restElapsed.map((w) => `${w.iso_year}|${w.iso_week}`),
  );
  for (const t of TARGETS) {
    const pts = await pageAll<{ year: number; week_number: number; points: number | null; checks_migrated: boolean | null }>(
      "user_weekly_points",
      "year,week_number,points,checks_migrated",
      (q) => q.eq("user_id", t.uid),
      "year",
    );
    const onRest = pts.filter((p) => restIsoKeys.has(`${p.year}|${p.week_number}`));
    console.log(`  ${t.name}: 전체 ${pts.length}행 | 휴식주차 위 ${onRest.length}행 (0 기대)`);
  }

  // ── 6) flip 후보 선택 시뮬레이션 ─────────────────────────────────────
  console.log("\n=== 6) flip 후보(최근 공표 휴식 주차 4개) + 예상 a ===");
  const candidates = [...restPublished].sort((a, b) => b.start_date.localeCompare(a.start_date));
  const pick4 = candidates.slice(0, 4).map((w) => w.start_date).sort();
  console.log(`  공통 후보 4주: ${pick4.join(", ")}`);
  const plan: any[] = [];
  for (const t of TARGETS) {
    const m = uwsByUser.get(t.uid)!;
    const flips = pick4.map((ws) => ({
      weekStart: ws,
      seasonKey: weekByStart.get(ws)?.season_key,
      uwsRow: m.get(ws) ? { status: m.get(ws)!.status, ovr: m.get(ws)!.ovr } : null,
    }));
    const ok = flips.every((f) => f.uwsRow?.status === "official_rest");
    // 현재 resolved a = 공표 활동주차 success 수 (26). flip 4 → 30.
    console.log(
      `  ${t.name}(${t.org}): flip 가능=${ok} → 예상 a=26+4=30 (>=30 충족) | 복원 ended_at=${t.endedBefore ?? "null"}`,
    );
    plan.push({ ...t, flips, ok });
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        restElapsed: restElapsed.map((w) => ({
          start: w.start_date,
          season: w.season_key,
          weekNumber: w.week_number,
          published: !!w.result_published_at,
          dbFlag: w.is_official_rest,
        })),
        activeUnpublished: activeUnpublished.map((w) => w.start_date),
        unifiedLinesOnRestWeeks: linesOnRest.length,
        pick4,
        plan,
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
