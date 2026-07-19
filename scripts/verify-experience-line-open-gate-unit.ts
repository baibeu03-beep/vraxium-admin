// 실무 경험 라인 개설 기간 게이트 SoT 단위 검증(순수 — DB/서버 불필요, tsx 로 바로 실행).
//   isExperienceLineOpenForWeek 결정표 = open_confirmed × practicalExperience[teamId] 체크 여부 × teamId 유무.
//   info(isInfoLineOpenForWeek)·competency(isCompetencyLineOpenForWeek)와 동일한 엄격(=== true, fallback 없음)
//   규칙을 따르는지 확인한다. 재현 사례(오랑캐·2026 여름 W2 = 오픈 확인 전 → 미오픈)를 대표 케이스로 포함.
//
//   실행: npx tsx scripts/verify-experience-line-open-gate-unit.ts

import { isExperienceLineOpenForWeek } from "../lib/weekOpenGate";
import type { SavedConfig } from "../lib/adminTeamPartsInfoWeekDetailData";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const TEAM = "team-A";
const OTHER = "team-B";

// 오픈 확인 + 팀 A 도출 체크된 정상 개설 기간 config.
const openedConfig: SavedConfig = {
  practicalExperience: { [TEAM]: { derive: true, analysis: false } },
};

console.log("── open_confirmed=false (오픈 확인 전) = 항상 미오픈 ──");
ok(
  "config 있어도 open_confirmed=false → false (재현: 오랑캐 여름 W2)",
  isExperienceLineOpenForWeek({ openConfirmed: false, config: openedConfig, teamId: TEAM }) === false,
);
ok(
  "config=null + open_confirmed=false → false (설정 행 없음 = fail-closed)",
  isExperienceLineOpenForWeek({ openConfirmed: false, config: null, teamId: TEAM }) === false,
);

console.log("── open_confirmed=true, 팀 단위(teamId 지정) ──");
ok(
  "팀 A 하나라도 체크(derive=true) → true",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: openedConfig, teamId: TEAM }) === true,
);
ok(
  "설정 없는 팀 B → false (엄격 · fallback true 없음)",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: openedConfig, teamId: OTHER }) === false,
);
ok(
  "팀 A 전부 false → false",
  isExperienceLineOpenForWeek({
    openConfirmed: true,
    config: { practicalExperience: { [TEAM]: { derive: false, analysis: false } } },
    teamId: TEAM,
  }) === false,
);
ok(
  "practicalExperience 자체 없음 → false",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: {}, teamId: TEAM }) === false,
);
ok(
  "config=null + open_confirmed=true → false",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: null, teamId: TEAM }) === false,
);

console.log("── open_confirmed=true, 허브 전체(teamId 미지정/null) ──");
ok(
  "어느 팀이든 하나라도 체크 → true",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: openedConfig, teamId: null }) === true,
);
ok(
  "모든 팀 미체크 → false",
  isExperienceLineOpenForWeek({
    openConfirmed: true,
    config: { practicalExperience: { [TEAM]: { derive: false }, [OTHER]: {} } },
    teamId: null,
  }) === false,
);
ok(
  "practicalExperience 없음(허브 전체) → false",
  isExperienceLineOpenForWeek({ openConfirmed: true, config: {}, teamId: null }) === false,
);

console.log("── 엄격성(=== true) — truthy 우회 방지 ──");
ok(
  "값이 문자열 'true' 등 non-boolean → false (=== true 만 인정)",
  isExperienceLineOpenForWeek({
    openConfirmed: true,
    // @ts-expect-error 의도적 오염 값(=== true 엄격 판정 확인)
    config: { practicalExperience: { [TEAM]: { derive: "true" } } },
    teamId: TEAM,
  }) === false,
);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
