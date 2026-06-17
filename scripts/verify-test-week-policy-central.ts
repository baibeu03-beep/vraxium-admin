// 중앙 테스트 모드 W13 예외 SoT 직접 검증 — lib/cluster4TestWeekPolicy.
//   실행: npx tsx scripts/verify-test-week-policy-central.ts
//
// 검증 목표(수정 요청 대비):
//   · operating 모드는 어떤 hub 든 base 그대로(운영 정책 불변 = W13 차단 유지).
//   · test 모드 휴식꼬리(W14~W16)는 모든 허용 hub 에서 동일하게 2026-spring W13 으로 폴드.
//   · test 모드 활동 주차(W10/W13)는 폴드하지 않음(옮기지 않음).
//   · 비예외 시즌/주차·operating 은 isCluster4TestExceptionWeek=false.
//   · 모든 hub 가 동일 규칙(중앙 1함수) — 기능별 분기 없음.

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

console.log("\n── 1) operating 모드 = base 불변(운영 정책 유지 · W13 차단) ──");
for (const hub of ALL_HUBS) {
  check(
    `operating/${hub}: W16→W16(폴드 없음)`,
    resolveCluster4TestOpenableWeekStartMs("operating", w16!, { hub, organization: null }) === w16,
  );
}

console.log("\n── 2) test 모드 휴식꼬리 → 모든 hub 동일하게 W13 폴드 ──");
for (const hub of ALL_HUBS) {
  // accrual 은 ms 폴드 대상이 아니지만(주차 행 판정 함수 사용), 정책 allowed=true 라 동일 폴드해도 무해.
  for (const [label, base] of [["W14", w14!], ["W15", w15!], ["W16", w16!]] as const) {
    check(
      `test/${hub}: ${label}→W13`,
      resolveCluster4TestOpenableWeekStartMs("test", base, { hub, organization: null }) === w13,
    );
  }
}

console.log("\n── 3) test 모드 활동 주차는 폴드하지 않음(옮기지 않음) ──");
check("test/info-line: W13→W13(불변)",
  resolveCluster4TestOpenableWeekStartMs("test", w13!, { hub: "info-line", organization: null }) === w13);
check("test/info-line: W10→W10(불변)",
  resolveCluster4TestOpenableWeekStartMs("test", w10!, { hub: "info-line", organization: null }) === w10);

console.log("\n── 4) org 게이트(전 조직 허용 — encre 제한 제거 확인) ──");
for (const org of ["encre", "oranke", "phalanx", "olympus", null]) {
  check(
    `test/experience-line org=${org}: W16→W13(전 조직)`,
    resolveCluster4TestOpenableWeekStartMs("test", w16!, { hub: "experience-line", organization: org }) === w13,
    `got ${resolveCluster4TestOpenableWeekStartMs("test", w16!, { hub: "experience-line", organization: org })}`,
  );
}

console.log("\n── 5) isCluster4TestExceptionWeek (accrual era 게이트용) ──");
check("test·2026-spring·W13 → true", isCluster4TestExceptionWeek("test", "2026-spring", 13) === true);
check("operating·2026-spring·W13 → false(운영 차단)", isCluster4TestExceptionWeek("operating", "2026-spring", 13) === false);
check("test·2026-spring·W12 → false", isCluster4TestExceptionWeek("test", "2026-spring", 12) === false);
check("test·2026-summer·W1 → false", isCluster4TestExceptionWeek("test", "2026-summer", 1) === false);
check("test·null·null → false", isCluster4TestExceptionWeek("test", null, null) === false);

console.log("\n── 6) isTestWeekExceptionAllowed (hub/org 정책) ──");
for (const hub of ALL_HUBS) {
  check(`operating/${hub} → false`, isTestWeekExceptionAllowed("operating", hub, null) === false);
  check(`test/${hub} → true(전 조직)`, isTestWeekExceptionAllowed("test", hub, null) === true);
}

console.log("\n── 7) config 단일 출처 확인 ──");
check("CLUSTER4_TEST_EXCEPTION_WEEKS = [2026-spring W13]",
  CLUSTER4_TEST_EXCEPTION_WEEKS.length === 1 &&
  CLUSTER4_TEST_EXCEPTION_WEEKS[0].seasonKey === "2026-spring" &&
  CLUSTER4_TEST_EXCEPTION_WEEKS[0].weekNumber === 13);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
