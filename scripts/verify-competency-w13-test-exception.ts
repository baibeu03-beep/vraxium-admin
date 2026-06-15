/**
 * READ-ONLY 검증(direct): 실무 역량(practical-competency) 테스트 모드 13주차 개설 예외.
 *   npx tsx --env-file=.env.local scripts/verify-competency-w13-test-exception.ts
 *
 * 검증:
 *   1) 순수 함수 resolveCompetencyTestWeekOverrideMs — test→W13, operating→null, 타 시즌→null.
 *   2) getCompetencyOpeningStatus(org, mode) targetWeek — test=W13(주차13) / operating=정규(휴식 주차).
 *      (opening-status 라우트는 readScopeMode + 이 함수 호출의 thin wrapper 라 direct == HTTP.)
 *   3) 운영 모드 targetWeek 가 기존(예외 미적용)과 동일 — 회귀 0.
 *   4) info/experience 정책 SoT(getOpenableWeekStartMs) 불변 — 다른 허브 무영향.
 */
import { createClient } from "@supabase/supabase-js";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { resolveCompetencyTestWeekOverrideMs } from "@/lib/cluster4CompetencyTestWeekException";
import { getCompetencyOpeningStatus } from "@/lib/adminCompetencyLineOpening";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ORGS = ["oranke", "encre", "phalanx"] as const;
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label} ${cond ? "" : "❌"}`);
  cond ? pass++ : fail++;
};

const DAY = 86_400_000;

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const regularMs = getOpenableWeekStartMs(todayIso);
  const regularInfo = regularMs != null ? describeWeekByStartMs(regularMs) : null;
  console.log("today:", todayIso);
  console.log(
    `정규 개설 대상(금요일 경계): W${regularInfo?.weekNumber} ${regularInfo?.weekStart} season=${regularInfo?.seasonKey} rest=${regularInfo?.isOfficialRest}`,
  );

  // ── 1) 순수 함수 ────────────────────────────────────────────────
  console.log("\n=== 1) resolveCompetencyTestWeekOverrideMs ===");
  const overTest = resolveCompetencyTestWeekOverrideMs("test", regularMs);
  const overOp = resolveCompetencyTestWeekOverrideMs("operating", regularMs);
  const overTestInfo = overTest != null ? describeWeekByStartMs(overTest) : null;
  ok(overOp === null, "operating → null(예외 미적용·운영 정책 유지)");
  if (regularInfo && regularInfo.seasonKey === "2026-spring" && regularInfo.weekNumber >= 14) {
    ok(
      overTestInfo?.seasonKey === "2026-spring" && overTestInfo?.weekNumber === 13,
      `test → 2026 봄 W13 (${overTestInfo?.weekStart})`,
    );
    ok(overTestInfo?.isOfficialRest === false, "test 대상 W13 은 활동 주차(휴식 아님)");
  } else {
    console.log("  · 현재는 2026 봄 휴식 꼬리 구간이 아님 — 시뮬레이션으로 검증");
  }
  // 시뮬레이션: 2026 봄 W15(06-08) 입력 시 항상 W13 로 고정.
  const w15Ms = Date.UTC(2026, 5, 8);
  const simTest = resolveCompetencyTestWeekOverrideMs("test", w15Ms);
  const simInfo = simTest != null ? describeWeekByStartMs(simTest) : null;
  ok(
    simInfo?.weekNumber === 13 && simInfo?.seasonKey === "2026-spring",
    `[sim] test + 2026봄 W15(06-08) → W13 (${simInfo?.weekStart})`,
  );
  // 시뮬레이션: 활동 주차(W12, 05-18) 입력 — 예외 미적용(정규가 이미 올바름).
  const w12Ms = Date.UTC(2026, 4, 18);
  ok(
    resolveCompetencyTestWeekOverrideMs("test", w12Ms) === null,
    "[sim] test + 2026봄 W12(활동 주차) → null(예외 미적용)",
  );
  // 시뮬레이션: 타 시즌(2026 여름 W2 ≈ 07-06) → null.
  const summerMs = Date.UTC(2026, 6, 6);
  const summerInfo = describeWeekByStartMs(summerMs);
  ok(
    summerInfo?.seasonKey !== "2026-spring"
      ? resolveCompetencyTestWeekOverrideMs("test", summerMs) === null
      : true,
    `[sim] test + 타 시즌(${summerInfo?.seasonKey}) → null(시즌 종료 시 예외 자동 만료)`,
  );

  // ── 2·3) getCompetencyOpeningStatus targetWeek ─────────────────
  console.log("\n=== 2·3) getCompetencyOpeningStatus(org, mode).targetWeek ===");
  for (const org of ORGS) {
    const stOp = await getCompetencyOpeningStatus(org, "operating");
    const stTs = await getCompetencyOpeningStatus(org, "test");
    const stDefault = await getCompetencyOpeningStatus(org);
    console.log(
      `  [${org}] operating target=W${stOp.targetWeek?.weekNumber}(${stOp.targetWeek?.startDate})` +
        ` / test target=W${stTs.targetWeek?.weekNumber}(${stTs.targetWeek?.startDate})`,
    );
    // 운영 = 정규 주차(예외 미적용) — 회귀 0.
    ok(
      stOp.targetWeek?.startDate === regularInfo?.weekStart,
      `[${org}] operating targetWeek == 정규(W${regularInfo?.weekNumber}) — 회귀 0`,
    );
    // 기본값(mode 미지정) == operating.
    ok(
      stDefault.targetWeek?.startDate === stOp.targetWeek?.startDate,
      `[${org}] mode 기본값 == operating`,
    );
    // 테스트 = W13(2026 봄 휴식 꼬리에서). 활동 주차 구간이면 정규와 동일(둘 다 정상).
    if (regularInfo?.seasonKey === "2026-spring" && (regularInfo?.weekNumber ?? 0) >= 14) {
      ok(
        stTs.targetWeek?.weekNumber === 13,
        `[${org}] test targetWeek == 2026 봄 W13`,
      );
      ok(
        stTs.targetWeek?.startDate !== stOp.targetWeek?.startDate,
        `[${org}] test ≠ operating (예외가 실제로 분기)`,
      );
    }
  }

  // ── 4) 공용 시즌/주차 정책 SoT 불변(다른 허브 무영향) ──────────────
  console.log("\n=== 4) 공용 정책 함수 불변(info/experience/career 무영향) ===");
  ok(
    getOpenableWeekStartMs(todayIso) === regularMs,
    "getOpenableWeekStartMs(공용 SoT) 결과 불변 — 예외는 역량 데이터 레이어 한정",
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
