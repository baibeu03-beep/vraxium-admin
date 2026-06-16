/**
 * READ-ONLY 검증(direct): 실무 경험(practical-experience) 테스트 모드 + encre 한정 13주차 개설 예외.
 *   npx tsx --env-file=.env.local scripts/verify-experience-w13-test-exception.ts
 *
 * 검증:
 *   1) 순수 함수 resolveExperienceTestWeekOverrideMs — encre+test→W13, operating→null,
 *      타 조직 test→null, 타 시즌→null, 활동 주차→null.
 *   2) opening-status 라우트와 동일한 targetWeek 산출(getOpenableWeekStartMs→override→describe→weeks.id):
 *      encre+test=W13(활동) / 그 외=정규(휴식 주차). direct == HTTP 의 direct 측.
 *   3) 운영 모드/타 조직 targetWeek 가 정규(예외 미적용)와 동일 — 회귀 0.
 *   4) 공용 정책 SoT(getOpenableWeekStartMs) 불변 — info/competency/career 무영향.
 */
import { createClient } from "@supabase/supabase-js";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { resolveExperienceTestWeekOverrideMs } from "@/lib/cluster4ExperienceTestWeekException";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ORGS = ["oranke", "encre", "phalanx", "olympus"] as const;
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label} ${cond ? "" : "❌"}`);
  cond ? pass++ : fail++;
};

// opening-status 라우트와 동일하게 effective openable ms → weeks.id 해석.
async function resolveTargetWeekId(startMs: number | null): Promise<string | null> {
  if (startMs == null) return null;
  const info = describeWeekByStartMs(startMs);
  if (!info) return null;
  const { data } = await sb
    .from("weeks")
    .select("id")
    .eq("iso_year", info.isoYear)
    .eq("iso_week", info.isoWeek)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const regularMs = getOpenableWeekStartMs(todayIso);
  const regularInfo = regularMs != null ? describeWeekByStartMs(regularMs) : null;
  console.log("today:", todayIso);
  console.log(
    `정규 개설 대상(금요일 경계): W${regularInfo?.weekNumber} ${regularInfo?.weekStart} season=${regularInfo?.seasonKey} rest=${regularInfo?.isOfficialRest}`,
  );
  const isRestTail =
    regularInfo?.seasonKey === "2026-spring" && (regularInfo?.weekNumber ?? 0) >= 14;

  // ── 1) 순수 함수 ────────────────────────────────────────────────
  console.log("\n=== 1) resolveExperienceTestWeekOverrideMs ===");
  ok(
    resolveExperienceTestWeekOverrideMs("operating", "encre", regularMs) === null,
    "operating + encre → null(운영 정책 유지)",
  );
  ok(
    resolveExperienceTestWeekOverrideMs("test", "oranke", regularMs) === null,
    "test + oranke → null(타 조직 예외 미적용)",
  );
  ok(
    resolveExperienceTestWeekOverrideMs("test", "phalanx", regularMs) === null,
    "test + phalanx → null(타 조직 예외 미적용)",
  );
  ok(
    resolveExperienceTestWeekOverrideMs("test", null, regularMs) === null,
    "test + org 없음 → null",
  );
  const overEncreTest = resolveExperienceTestWeekOverrideMs("test", "encre", regularMs);
  const overEncreInfo = overEncreTest != null ? describeWeekByStartMs(overEncreTest) : null;
  if (isRestTail) {
    ok(
      overEncreInfo?.seasonKey === "2026-spring" && overEncreInfo?.weekNumber === 13,
      `test + encre → 2026 봄 W13 (${overEncreInfo?.weekStart})`,
    );
    ok(overEncreInfo?.isOfficialRest === false, "test+encre 대상 W13 은 활동 주차(휴식 아님·개설 가능)");
  } else {
    console.log("  · 현재는 2026 봄 휴식 꼬리 구간이 아님 — 시뮬레이션으로 검증");
  }
  // 시뮬레이션: 2026 봄 W15(06-08, 휴식) 입력 → encre+test 만 W13 고정.
  const w15Ms = Date.UTC(2026, 5, 8);
  const simEncre = resolveExperienceTestWeekOverrideMs("test", "encre", w15Ms);
  const simEncreInfo = simEncre != null ? describeWeekByStartMs(simEncre) : null;
  ok(
    simEncreInfo?.weekNumber === 13 && simEncreInfo?.seasonKey === "2026-spring",
    `[sim] test+encre + 2026봄 W15(06-08) → W13 (${simEncreInfo?.weekStart})`,
  );
  ok(
    resolveExperienceTestWeekOverrideMs("test", "oranke", w15Ms) === null,
    "[sim] test+oranke + 2026봄 W15 → null(조직 게이트)",
  );
  ok(
    resolveExperienceTestWeekOverrideMs("operating", "encre", w15Ms) === null,
    "[sim] operating+encre + 2026봄 W15 → null(모드 게이트)",
  );
  // 시뮬레이션: 활동 주차(W12, 05-18) → null(정규가 이미 올바름).
  const w12Ms = Date.UTC(2026, 4, 18);
  ok(
    resolveExperienceTestWeekOverrideMs("test", "encre", w12Ms) === null,
    "[sim] test+encre + 2026봄 W12(활동) → null(예외 미적용)",
  );
  // 시뮬레이션: 타 시즌(2026 여름) → null(시즌 종료 시 자동 만료).
  const summerMs = Date.UTC(2026, 6, 6);
  const summerInfo = describeWeekByStartMs(summerMs);
  ok(
    summerInfo?.seasonKey !== "2026-spring"
      ? resolveExperienceTestWeekOverrideMs("test", "encre", summerMs) === null
      : true,
    `[sim] test+encre + 타 시즌(${summerInfo?.seasonKey}) → null(자동 만료)`,
  );

  // ── 2·3) opening-status 라우트 targetWeek 산출(direct) ─────────────
  console.log("\n=== 2·3) opening-status targetWeek 산출(라우트 로직 재현) ===");
  for (const org of ORGS) {
    const opMs =
      resolveExperienceTestWeekOverrideMs("operating", org, regularMs) ?? regularMs;
    const tsMs =
      resolveExperienceTestWeekOverrideMs("test", org, regularMs) ?? regularMs;
    const opInfo = opMs != null ? describeWeekByStartMs(opMs) : null;
    const tsInfo = tsMs != null ? describeWeekByStartMs(tsMs) : null;
    const opWeekId = await resolveTargetWeekId(opMs);
    const tsWeekId = await resolveTargetWeekId(tsMs);
    console.log(
      `  [${org}] operating W${opInfo?.weekNumber}(${opInfo?.weekStart}) id=${opWeekId?.slice(0, 8)}` +
        ` / test W${tsInfo?.weekNumber}(${tsInfo?.weekStart}) id=${tsWeekId?.slice(0, 8)}`,
    );
    // 운영 = 정규(예외 미적용) — 회귀 0.
    ok(
      opInfo?.weekStart === regularInfo?.weekStart,
      `[${org}] operating targetWeek == 정규(W${regularInfo?.weekNumber}) — 회귀 0`,
    );
    if (org === "encre" && isRestTail) {
      ok(tsInfo?.weekNumber === 13, `[${org}] test targetWeek == 2026 봄 W13`);
      ok(
        tsInfo?.weekStart !== opInfo?.weekStart,
        `[${org}] test ≠ operating (예외 실제 분기)`,
      );
      ok(tsWeekId != null, `[${org}] test W13 weeks.id 존재(개설 주차로 사용 가능)`);
    } else {
      // 타 조직 / 활동 주차 구간 → test == operating(예외 미적용).
      ok(
        tsInfo?.weekStart === opInfo?.weekStart,
        `[${org}] test == operating(예외 미적용·회귀 0)`,
      );
    }
  }

  // ── 4) 공용 정책 SoT 불변 ──────────────────────────────────────
  console.log("\n=== 4) 공용 정책 함수 불변(info/competency/career 무영향) ===");
  ok(
    getOpenableWeekStartMs(todayIso) === regularMs,
    "getOpenableWeekStartMs(공용 SoT) 결과 불변 — 예외는 경험 데이터 레이어/상태창 한정",
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
