// 중앙 테스트 주차 정책 SoT 직접 검증 — lib/cluster4TestWeekPolicy.
//   실행: npx tsx scripts/verify-test-week-policy-central.ts
//
// 【2026-07-01 정책 변경】"테스트 모드 휴식꼬리 W13 예외"는 폐지됐다.
//   주차/시즌/개설 대상 주차는 항상 operating(정규 금요일 경계) 기준이며, QA 여부와 무관하다.
//   이 모듈은 시그니처 호환용 pass-through 로만 남아있다. 본 스크립트는 그 "무예외(pass-through)"
//   계약을 회귀 가드로 검증한다 — 즉 test-week 예외가 다시 살아나지 않았는지 확인한다.
//
// 검증 목표(현행 모델):
//   · resolveCluster4TestOpenableWeekStartMs 는 mode/hub/org 무관하게 base 를 그대로 반환(폴드 없음).
//   · isCluster4TestExceptionWeek 는 항상 false.
//   · isTestWeekExceptionAllowed 는 항상 false.
//   · CLUSTER4_TEST_EXCEPTION_WEEKS 는 비어있다(예외 config 없음).

import {
  resolveCluster4TestOpenableWeekStartMs,
  isCluster4TestExceptionWeek,
  isTestWeekExceptionAllowed,
  CLUSTER4_TEST_EXCEPTION_WEEKS,
  type Cluster4TestWeekHub,
} from "@/lib/cluster4TestWeekPolicy";
import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";

const DAY_MS = 86_400_000;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

// 2026-spring 주차번호 → 시작 ms 맵 (Mondays 스캔 — 머신 today 무관, 시즌 캘린더 기반).
const springWeekStartMs = new Map<number, number>();
{
  let ms = Date.UTC(2026, 0, 5); // 2026-01-05 (월).
  for (let i = 0; i < 30; i++) {
    const d = describeWeekByStartMs(ms);
    if (d && d.seasonKey === "2026-spring") springWeekStartMs.set(d.weekNumber, ms);
    ms += 7 * DAY_MS;
  }
}

const ALL_HUBS: Cluster4TestWeekHub[] = [
  "info-line",
  "experience-line",
  "competency-line",
  "career-line",
  "process-info",
  "process-experience",
  "process-competency",
  "process-career",
  "process-irregular",
  "accrual",
  "dropdown",
];

console.log("── 0) 사전: 2026-spring 주차 맵 ──");
const w13 = springWeekStartMs.get(13);
const w16 = springWeekStartMs.get(16);
const w15 = springWeekStartMs.get(15);
const w14 = springWeekStartMs.get(14);
const w10 = springWeekStartMs.get(10);
check("W13~W16·W10 시작 ms 확보", [w13, w14, w15, w16, w10].every((x) => x != null),
  `w13=${w13} w14=${w14} w15=${w15} w16=${w16} w10=${w10}`);
// W14~W16 = 공식 휴식, W10·W13 = 활동(비휴식)인지 확인.
check("W13 = 활동 주차(비휴식)", describeWeekByStartMs(w13!)?.isOfficialRest === false);
check("W14 = 공식 휴식", describeWeekByStartMs(w14!)?.isOfficialRest === true);
check("W16 = 공식 휴식", describeWeekByStartMs(w16!)?.isOfficialRest === true);

console.log("\n── 1) operating 모드: base 그대로(폴드 없음) ──");
for (const hub of ALL_HUBS) {
  check(
    `operating/${hub}: W16→W16(불변)`,
    resolveCluster4TestOpenableWeekStartMs("operating", w16!, { hub, organization: null }) === w16,
  );
}

console.log("\n── 2) test 모드 휴식꼬리도 폴드하지 않음(예외 폐지 — base 그대로) ──");
for (const hub of ALL_HUBS) {
  for (const [label, base] of [["W14", w14!], ["W15", w15!], ["W16", w16!]] as const) {
    check(
      `test/${hub}: ${label}→${label}(불변)`,
      resolveCluster4TestOpenableWeekStartMs("test", base, { hub, organization: null }) === base,
    );
  }
}

console.log("\n── 3) test 모드 활동 주차도 그대로(옮기지 않음) ──");
check("test/info-line: W13→W13(불변)",
  resolveCluster4TestOpenableWeekStartMs("test", w13!, { hub: "info-line", organization: null }) === w13);
check("test/info-line: W10→W10(불변)",
  resolveCluster4TestOpenableWeekStartMs("test", w10!, { hub: "info-line", organization: null }) === w10);

console.log("\n── 4) org 게이트 무관(전 조직 동일 — 폴드 없음) ──");
for (const org of ["encre", "oranke", "phalanx", "olympus", null]) {
  check(
    `test/experience-line org=${org}: W16→W16(불변)`,
    resolveCluster4TestOpenableWeekStartMs("test", w16!, { hub: "experience-line", organization: org }) === w16,
    `got ${resolveCluster4TestOpenableWeekStartMs("test", w16!, { hub: "experience-line", organization: org })}`,
  );
}

console.log("\n── 5) isCluster4TestExceptionWeek: 항상 false(예외 폐지) ──");
check("test·2026-spring·W13 → false", isCluster4TestExceptionWeek("test", "2026-spring", 13) === false);
check("operating·2026-spring·W13 → false", isCluster4TestExceptionWeek("operating", "2026-spring", 13) === false);
check("test·2026-spring·W12 → false", isCluster4TestExceptionWeek("test", "2026-spring", 12) === false);
check("test·2026-summer·W1 → false", isCluster4TestExceptionWeek("test", "2026-summer", 1) === false);
check("test·null·null → false", isCluster4TestExceptionWeek("test", null, null) === false);

console.log("\n── 6) isTestWeekExceptionAllowed: 항상 false(예외 폐지) ──");
for (const hub of ALL_HUBS) {
  check(`operating/${hub} → false`, isTestWeekExceptionAllowed("operating", hub, null) === false);
  check(`test/${hub} → false`, isTestWeekExceptionAllowed("test", hub, null) === false);
}

console.log("\n── 7) config 비어있음 확인(예외 없음) ──");
check("CLUSTER4_TEST_EXCEPTION_WEEKS = [] (예외 config 없음)",
  CLUSTER4_TEST_EXCEPTION_WEEKS.length === 0);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
