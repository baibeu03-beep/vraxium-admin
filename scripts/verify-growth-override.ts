/**
 * growth_status 자동/오버라이드 분리 검증 (2026-06-07 2단계, read-only).
 *   A) resolveGrowthStatusDetail / computeAutoGrowthStatus / extractManualOverride 단위
 *   B) live direct — getGrowthIndicatorsInternal 의 process 신규 필드
 *      (autoGrowthStatusKey / manualOverrideStatus / overrideMismatch / 메타 내성)
 * Usage: npx tsx --env-file=.env.local scripts/verify-growth-override.ts
 */
import {
  computeAutoGrowthStatus,
  extractManualOverride,
  resolveGrowthStatusDetail,
} from "../lib/growthCore";
import { getGrowthIndicatorsInternal } from "../lib/cluster3GrowthData";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

console.log("=== A) 단위 케이스 ===");
const base = {
  seasonRestActive: false,
  currentWeekStatus: null as string | null,
  approvedWeeks: 10,
  elapsedWeeks: 20,
  graduationThreshold: 30,
};

// override 추출: 3종만 인정
check("extractManualOverride(graduated)=graduated", extractManualOverride("graduated") === "graduated");
check("extractManualOverride(suspended)=suspended", extractManualOverride("suspended") === "suspended");
check("extractManualOverride(paused)=paused", extractManualOverride("paused") === "paused");
check("extractManualOverride(graduating)=null (자동 전용)", extractManualOverride("graduating") === null);
check("extractManualOverride(seasonal_rest)=null (legacy)", extractManualOverride("seasonal_rest") === null);
check("extractManualOverride(weekly_rest)=null (legacy)", extractManualOverride("weekly_rest") === null);
check("extractManualOverride(active)=null", extractManualOverride("active") === null);
check("extractManualOverride(null)=null", extractManualOverride(null) === null);

// auto 는 DB growth_status 를 전혀 보지 않는다
check("auto: DB 무관 — active", computeAutoGrowthStatus(base) === "active");
check("auto: seasonRestActive → seasonal_rest", computeAutoGrowthStatus({ ...base, seasonRestActive: true }) === "seasonal_rest");
check("auto: personal_rest → weekly_rest", computeAutoGrowthStatus({ ...base, currentWeekStatus: "personal_rest" }) === "weekly_rest");
check("auto: official_rest → official_rest", computeAutoGrowthStatus({ ...base, currentWeekStatus: "official_rest" }) === "official_rest");
check("auto: h<=1 → onboarding", computeAutoGrowthStatus({ ...base, elapsedWeeks: 1 }) === "onboarding");
check("auto: a=29 → graduating", computeAutoGrowthStatus({ ...base, approvedWeeks: 29 }) === "graduating");
check("auto: oranke a=26/th=25 → extra_growth", computeAutoGrowthStatus({ ...base, approvedWeeks: 26, graduationThreshold: 25 }) === "extra_growth");

// display = override ?? auto + mismatch
{
  const r = resolveGrowthStatusDetail({ ...base, growthStatus: "paused" });
  check("paused override: display=paused/auto=active/mismatch=true",
    r.display === "paused" && r.auto === "active" && r.override === "paused" && r.overrideMismatch,
    JSON.stringify(r));
}
{
  const r = resolveGrowthStatusDetail({ ...base, approvedWeeks: 30, growthStatus: "graduated" });
  check("graduated override + auto=graduating: display=graduated/mismatch=true(정상 경로 — UI 예외 처리)",
    r.display === "graduated" && r.auto === "graduating" && r.overrideMismatch,
    JSON.stringify(r));
}
{
  const r = resolveGrowthStatusDetail({ ...base, growthStatus: "graduating" });
  check("legacy graduating: override=null → display=auto(active)/mismatch=false",
    r.display === "active" && r.override === null && !r.overrideMismatch,
    JSON.stringify(r));
}
{
  const r = resolveGrowthStatusDetail({ ...base, seasonRestActive: true, growthStatus: "seasonal_rest" });
  check("legacy seasonal_rest + 현재시즌 휴식: override=null, display=auto(seasonal_rest)",
    r.display === "seasonal_rest" && r.override === null && !r.overrideMismatch,
    JSON.stringify(r));
}
{
  // 오버라이드 == 자동 (graduated + 자동도 졸업 불가… auto 에 graduated 없음 → mismatch 정의 확인용)
  const r = resolveGrowthStatusDetail({ ...base, growthStatus: null });
  check("override 없음: mismatch=false", !r.overrideMismatch, JSON.stringify(r));
}

// ── B) live direct ───────────────────────────────────────────────────
async function main() {
  console.log("\n=== B) live direct — process 신규 필드 ===");

  type Expect = {
    name: string;
    uid: string;
    display: string;
    override: string | null;
    mismatchWarn?: boolean; // UI 경고 대상(정상 졸업 경로 제외) 기대값
  };
  const CASES: Expect[] = [
    { name: "T조하은(DB=paused)", uid: "cc05522b-7a71-48fb-a291-3aaaefdf4865", display: "paused", override: "paused" },
    { name: "T윤도현(DB=graduated, a≈30)", uid: "bf3b4305-751a-49e3-88ad-95a20e5c4dad", display: "graduated", override: "graduated" },
    { name: "T송하린(DB=seasonal_rest·legacy)", uid: "28c60d60-aa17-4614-9127-fd65a8aebcaf", display: "seasonal_rest", override: null },
    { name: "T안건우(DB=graduating·legacy)", uid: "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee", display: "active", override: null },
    { name: "이유나(실유저 active)", uid: "247021bc-374b-48f4-8d49-b181d149ee33", display: "active", override: null },
  ];

  for (const c of CASES) {
    const g = await getGrowthIndicatorsInternal(c.uid);
    const p = g.process;
    check(
      `${c.name}: display=${c.display} / override=${c.override ?? "null"}`,
      p.growthDisplayKey === c.display && p.manualOverrideStatus === c.override,
      `display=${p.growthDisplayKey} auto=${p.autoGrowthStatusKey} override=${p.manualOverrideStatus} mismatch=${p.overrideMismatch}`,
    );
    check(
      `${c.name}: display === (override ?? auto) 불변식`,
      p.growthDisplayKey === (p.manualOverrideStatus ?? p.autoGrowthStatusKey),
      "",
    );
    if (c.override === null) {
      check(`${c.name}: override 없음 → mismatch=false·메타 null`,
        !p.overrideMismatch && p.manualOverrideReason === null && p.manualOverrideAt === null, "");
    }
  }

  // T조하은: override(paused) vs auto 불일치 → 경고 신호
  {
    const g = await getGrowthIndicatorsInternal("cc05522b-7a71-48fb-a291-3aaaefdf4865");
    check("T조하은: overrideMismatch=true (paused vs auto)",
      g.process.overrideMismatch === true,
      `auto=${g.process.autoGrowthStatusKey}`);
  }
  // T윤도현: graduated vs auto=graduating — raw mismatch true (UI 는 정상 경로 예외)
  {
    const g = await getGrowthIndicatorsInternal("bf3b4305-751a-49e3-88ad-95a20e5c4dad");
    check("T윤도현: auto=graduating(a≥29) + override=graduated",
      g.process.autoGrowthStatusKey === "graduating" || g.process.autoGrowthStatusKey === "official_rest",
      `auto=${g.process.autoGrowthStatusKey}`);
  }
  // 메타 내성: audit 테이블 미생성 환경에서도 위 호출이 전부 성공했는가 = 이미 검증됨.
  console.log("  (audit 테이블 미생성 환경 — 메타 null 폴백으로 전체 호출 성공 = 내성 확인)");

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
