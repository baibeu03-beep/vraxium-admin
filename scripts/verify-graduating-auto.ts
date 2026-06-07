/**
 * graduating 자동 계산 전환 검증 (2026-06-07, read-only).
 *   A) resolveGrowthStatus 순수 함수 단위 케이스 (synthetic)
 *   B) live direct — getGrowthIndicatorsInternal (DB 읽기만, 쓰기 없음)
 *      - 수동 graduating 테스터 7명: 더 이상 graduating 표시 아님
 *      - graduated/paused/seasonal_rest override·휴식 불변
 *      - 실유저 회귀
 *      - what-if: graduated 테스터의 실데이터 a/h 로 override 제거 시 graduating 인지
 * Usage: npx tsx --env-file=.env.local scripts/verify-graduating-auto.ts
 */
import {
  resolveGrowthStatus,
  GRADUATING_FROM_APPROVED_WEEKS,
} from "../lib/growthCore";
import { getGrowthIndicatorsInternal } from "../lib/cluster3GrowthData";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ── A) 순수 함수 단위 케이스 ─────────────────────────────────────────
console.log(`=== A) resolveGrowthStatus 단위 케이스 (기준=${GRADUATING_FROM_APPROVED_WEEKS}) ===`);
const base = {
  seasonRestActive: false,
  currentWeekStatus: null as string | null,
  elapsedWeeks: 20,
};

// 검증 1: 19주 사용자는 graduating 아님 (DB 수동 graduating 이어도)
check("a=19/th=30, DB=graduating → active (수동값 비신뢰)",
  resolveGrowthStatus({ ...base, growthStatus: "graduating", approvedWeeks: 19, graduationThreshold: 30 }) === "active");
check("a=19/th=30, DB=active → active",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 19, graduationThreshold: 30 }) === "active");
// 검증 2: 29주차 승인 완료 → graduating
check("a=29/th=30, DB=active → graduating",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 29, graduationThreshold: 30 }) === "graduating");
check("a=29/th=30, DB=graduating → graduating (자동 조건 충족)",
  resolveGrowthStatus({ ...base, growthStatus: "graduating", approvedWeeks: 29, graduationThreshold: 30 }) === "graduating");
check("a=30/th=30, DB=active → graduating (졸업 완료 전까지 유지)",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 30, graduationThreshold: 30 }) === "graduating");
check("a=35/th=30, DB=null → graduating",
  resolveGrowthStatus({ ...base, growthStatus: null, approvedWeeks: 35, graduationThreshold: 30 }) === "graduating");
// 검증 3: graduated override 최우선
check("a=31, DB=graduated → graduated (override 우선)",
  resolveGrowthStatus({ ...base, growthStatus: "graduated", approvedWeeks: 31, graduationThreshold: 30 }) === "graduated");
// override 2종 유지
check("DB=suspended → suspended", resolveGrowthStatus({ ...base, growthStatus: "suspended", approvedWeeks: 29, graduationThreshold: 30 }) === "suspended");
check("DB=paused → paused", resolveGrowthStatus({ ...base, growthStatus: "paused", approvedWeeks: 29, graduationThreshold: 30 }) === "paused");
// 휴식 2종 > graduating (2026-06-07 2단계: DB 값이 아닌 휴식 기록에서 자동 도출)
check("현재시즌 휴식 신청 + a=29 → seasonal_rest (우선순위)",
  resolveGrowthStatus({ ...base, seasonRestActive: true, growthStatus: "active", approvedWeeks: 29, graduationThreshold: 30 }) === "seasonal_rest");
check("현재주 personal_rest + a=29 → weekly_rest (우선순위)",
  resolveGrowthStatus({ ...base, currentWeekStatus: "personal_rest", growthStatus: "active", approvedWeeks: 29, graduationThreshold: 30 }) === "weekly_rest");
// official_rest/onboarding > graduating
check("현재주 official_rest + a=29 → official_rest (우선순위)",
  resolveGrowthStatus({ ...base, growthStatus: "active", currentWeekStatus: "official_rest", approvedWeeks: 29, graduationThreshold: 30 }) === "official_rest");
check("h=1 + a=29 → onboarding (우선순위, 이론 케이스)",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 29, elapsedWeeks: 1, graduationThreshold: 30 }) === "onboarding");
// oranke (th=25 < 29): 25~28 = extra_growth, 29+ = graduating
check("oranke a=25/th=25 → extra_growth",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 25, graduationThreshold: 25 }) === "extra_growth");
check("oranke a=28/th=25 → extra_growth",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 28, graduationThreshold: 25 }) === "extra_growth");
check("oranke a=29/th=25 → graduating",
  resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 29, graduationThreshold: 25 }) === "graduating");
// 회귀: 기존 자동 분기 불변
check("a=5/th=30 → active", resolveGrowthStatus({ ...base, growthStatus: "active", approvedWeeks: 5, graduationThreshold: 30 }) === "active");
check("h=0 → onboarding", resolveGrowthStatus({ growthStatus: "active", currentWeekStatus: null, approvedWeeks: 0, elapsedWeeks: 0, graduationThreshold: 30 }) === "onboarding");
check("org 없음(th=null) a=29 → graduating (29 기준은 org 무관)",
  resolveGrowthStatus({ ...base, growthStatus: null, approvedWeeks: 29, graduationThreshold: null }) === "graduating");

// ── B) live direct ───────────────────────────────────────────────────
async function main() {
console.log("\n=== B) live direct — getGrowthIndicatorsInternal ===");

const GRADUATING_TESTERS: Array<[string, string]> = [
  ["T안건우(a≈18, oranke)", "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee"],
  ["T윤서진(a≈23, encre)", "76a42307-f3b2-4c08-92ab-f339a20b7d38"],
  ["T황하린(a≈19, oranke)", "8e38d52f-727e-429b-9db3-423cd031d2a5"],
  ["T강지아(a≈21, encre)", "369d11e5-8c9e-423c-95e8-4e52a62460d7"],
  ["T강지환(a≈20, phalanx)", "6678e364-68ad-4aa1-a531-79f62c2c166a"],
  ["T조서현(a≈19, phalanx)", "b303c17e-26ec-429c-804e-f0d25c3f9463"],
  ["T조민재(a≈19, encre)", "ec11fe34-0cba-4bbc-afae-6d7514fdf57e"],
];

for (const [name, uid] of GRADUATING_TESTERS) {
  const g = await getGrowthIndicatorsInternal(uid);
  const key = g.process.growthDisplayKey;
  check(
    `DB=graduating ${name}: 표시 ≠ graduating`,
    key !== "graduating",
    `display=${key} (a=${g.period.a}, h=${g.period.h}, raw=${g.process.growthStatus})`,
  );
}

// override·휴식 불변
for (const [name, uid, expect] of [
  ["T윤도현(graduated, a≈31)", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "graduated"],
  ["T홍지환(graduated, a≈27 oranke)", "e6574586-6279-41cc-ae36-1c9dc3078bc3", "graduated"],
  ["T조하은(paused)", "cc05522b-7a71-48fb-a291-3aaaefdf4865", "paused"],
  ["T송하린(seasonal_rest)", "28c60d60-aa17-4614-9127-fd65a8aebcaf", "seasonal_rest"],
] as const) {
  const g = await getGrowthIndicatorsInternal(uid);
  check(`${name}: 표시=${expect} 불변`, g.process.growthDisplayKey === expect,
    `display=${g.process.growthDisplayKey} (a=${g.period.a})`);
}

// 실유저 회귀 (이유나 active)
{
  const g = await getGrowthIndicatorsInternal("247021bc-374b-48f4-8d49-b181d149ee33");
  check("실유저 이유나(active): 표시 ≠ graduating", g.process.growthDisplayKey !== "graduating",
    `display=${g.process.growthDisplayKey} (a=${g.period.a}, h=${g.period.h})`);
}

// what-if: graduated 테스터의 실데이터 a/h 에서 override 만 제거하면 graduating 인가
{
  const g = await getGrowthIndicatorsInternal("bf3b4305-751a-49e3-88ad-95a20e5c4dad"); // T윤도현 a≈31
  const whatIf = resolveGrowthStatus({
    growthStatus: null,
    seasonRestActive: false,
    currentWeekStatus: g._debug.currentWeekStatus,
    approvedWeeks: g.period.a,
    elapsedWeeks: g.period.h,
    graduationThreshold: g._debug.graduationThreshold,
  });
  check(
    `what-if: T윤도현 실데이터(a=${g.period.a}) override 제거 → graduating`,
    whatIf === "graduating" || g._debug.currentWeekStatus === "official_rest",
    `whatIf=${whatIf} (currentWeekStatus=${g._debug.currentWeekStatus})`,
  );
}

console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
}
void main();
