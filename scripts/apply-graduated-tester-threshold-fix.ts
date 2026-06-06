/**
 * graduated 테스터 졸업 기준 정합 보정 (2026-06-05).
 *
 *   npx tsx --env-file=.env.local scripts/apply-graduated-tester-threshold-fix.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-graduated-tester-threshold-fix.ts --apply  # 실반영
 *
 * 배경: v17 레거시 통합 마이그레이션의 졸업 트랙은 "가용 활동 주차 전부 성공"으로
 *   임계(25~30)에 최대한 근접시켰으나, weeks 캘린더의 종료 활동 주차가 27개뿐이라
 *   encre/phalanx(임계 30) graduated 테스터는 표시 a=26 으로 기준 미충족인 채
 *   "성장 완료(졸업)"로 노출됐다 (oranke 임계 25 는 26≥25 충족 — 변경 없음).
 *
 * 처리(데이터 기반 — 하드코딩 명단 없음):
 *   - graduated 테스터 중 표시 a(getGrowthIndicatorsInternal — 화면과 동일 fold)
 *     < 조직 임계 인 사용자:
 *       · top-up 가능(종료 활동 주차 수 >= 임계)하면 → 에러로 중단 (이 스크립트는
 *         강등 전용. 충족 가능한데 미충족이면 주차 데이터 보정이 정답이므로 별도 처리)
 *       · top-up 불가(캘린더 상한 < 임계) → growth_status='active'(진행 중),
 *         activity_ended_at=NULL 로 강등
 *   - 기준 충족 graduated 테스터/실사용자/그 외 상태는 일절 불변.
 *
 * 실사용자 보호: 쓰기 직전 test_user_markers 멤버십 assert (v17 과 동일).
 * 멱등: 강등 후 재실행 시 대상 0명. 원복 키 = 로그 JSON 의 before 값.
 * 후속 재계산: uws/포인트/라인 불변 → user_growth_stats·weekly-cards snapshot 재계산
 *   불필요 (growth_status 는 양쪽 어디에도 비포함 — resume seasonRecords graft·
 *   weekly-growth seasonSummary 는 LIVE 파생이라 즉시 반영).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");
const LOG_PATH = "claudedocs/graduated-tester-threshold-fix-20260605.json";

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "user_id",
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
  console.log(`모드: ${APPLY ? "APPLY(실반영)" : "DRY-RUN"}`);

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

  // ── 0. 테스터 + graduated 프로필 ────────────────────────────────────
  const [markers, gradProfiles] = await Promise.all([
    pageAll<{ user_id: string }>("test_user_markers", "user_id"),
    pageAll<{
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
      growth_status: string | null;
      activity_ended_at: string | null;
    }>(
      "user_profiles",
      "user_id,display_name,organization_slug,growth_status,activity_ended_at",
      (q) => q.eq("growth_status", "graduated"),
    ),
  ]);
  const testerIds = new Set(markers.map((m) => m.user_id));
  const graduatedTesters = gradProfiles.filter((p) => testerIds.has(p.user_id));
  const graduatedReal = gradProfiles.filter((p) => !testerIds.has(p.user_id));
  console.log(
    `graduated: 테스터 ${graduatedTesters.length} / 실사용자 ${graduatedReal.length}(불변)`,
  );

  // ── 1. top-up 상한 = weeks 캘린더의 종료 활동 주차 수 ────────────────
  const todayIso = new Date().toISOString().slice(0, 10);
  const [weeks, restPeriods] = await Promise.all([
    pageAll<{ start_date: string; end_date: string | null }>(
      "weeks",
      "start_date,end_date",
      undefined,
      "start_date",
    ),
    fetchActiveRestPeriods(),
  ]);
  const activeElapsed = weeks.filter((w) => {
    if (isTransitionWeekStart(w.start_date)) return false;
    const endDate = w.end_date ?? w.start_date;
    if (endDate >= todayIso) return false;
    const rest =
      isSeasonRuleRestForWeekStart(w.start_date) ||
      matchOfficialRestPeriods({ startDate: w.start_date, endDate }, restPeriods)
        .length > 0;
    return !rest;
  }).length;
  console.log(`종료 활동 주차(top-up 상한): ${activeElapsed}`);

  // ── 2. 대상 판정 — 표시 레이어와 동일 a ─────────────────────────────
  type Demote = {
    userId: string;
    name: string | null;
    org: string | null;
    threshold: number;
    displayA: number;
    displayH: number;
    before: { growth_status: string | null; activity_ended_at: string | null };
  };
  const demotes: Demote[] = [];
  const kept: string[] = [];

  for (const p of graduatedTesters) {
    const thr =
      (GRADUATION_THRESHOLDS as Record<string, number>)[
        p.organization_slug ?? ""
      ] ?? null;
    if (thr === null) {
      console.warn(`  조직 임계 미정(${p.organization_slug}) — 건너뜀: ${p.display_name}`);
      continue;
    }
    const ind = await getGrowthIndicatorsInternal(p.user_id);
    const a = ind.period.a;
    if (a >= thr) {
      kept.push(`${p.display_name}(${p.organization_slug} a=${a}≥${thr})`);
      continue;
    }
    if (activeElapsed >= thr) {
      throw new Error(
        `top-up 가능 케이스 발견(${p.display_name}: a=${a} < thr=${thr} <= 가용 ${activeElapsed}) — ` +
          `이 스크립트는 강등 전용입니다. 주차 데이터 top-up 으로 처리하세요.`,
      );
    }
    demotes.push({
      userId: p.user_id,
      name: p.display_name,
      org: p.organization_slug,
      threshold: thr,
      displayA: a,
      displayH: ind.period.h,
      before: {
        growth_status: p.growth_status,
        activity_ended_at: p.activity_ended_at,
      },
    });
  }

  console.log(`\n유지(기준 충족): ${kept.length}명 — ${kept.join(", ") || "(없음)"}`);
  console.log(`강등 대상: ${demotes.length}명`);
  for (const d of demotes) {
    console.log(
      `  [${d.org}] ${d.name} a=${d.displayA} < thr=${d.threshold} (캘린더 상한 ${activeElapsed} < ${d.threshold} → 충족 불가) ` +
        `ended_at=${d.before.activity_ended_at ?? "null"} → graduated→active, ended_at→null`,
    );
  }

  if (!APPLY) {
    console.log("\n(dry-run — DB 변경 없음. --apply 로 실행)");
    return;
  }

  // ── 3. 적용 (테스터 assert 후 개별 update) ──────────────────────────
  for (const d of demotes) {
    if (!testerIds.has(d.userId)) {
      throw new Error(`강등 대상에 비테스터 포함: ${d.userId}`);
    }
    const { error } = await sb
      .from("user_profiles")
      .update({ growth_status: "active", activity_ended_at: null })
      .eq("user_id", d.userId)
      .eq("growth_status", "graduated"); // 동시 변경 가드
    if (error) throw new Error(`강등 UPDATE 실패(${d.name}): ${error.message}`);
  }
  console.log(`\n강등 적용 완료: ${demotes.length}명`);

  const fileLog = existsSync(LOG_PATH)
    ? JSON.parse(readFileSync(LOG_PATH, "utf8"))
    : { runs: [] };
  fileLog.runs.push({
    runAt: new Date().toISOString(),
    activeElapsed,
    kept,
    demotes,
  });
  writeFileSync(LOG_PATH, JSON.stringify(fileLog, null, 2));
  console.log(`로그 기록: ${LOG_PATH} (원복 키 = demotes[].before)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
