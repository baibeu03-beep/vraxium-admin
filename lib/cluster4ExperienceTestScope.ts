// 실무 경험 — 테스트 팀 레지스트리 (B안 이후 축소판).
// ─────────────────────────────────────────────────────────────────────
// 테스터 90명 가상 재배치(2026-06-12)로 생성된 9개 (org, 팀명) = "테스트 팀".
// 팀명은 "(T)" 접미사로 시드(seed90-test-team-reassignment).
//
// 용도(Phase 3 이후):
//   · 사용자 포함/제외 판정은 더 이상 팀 carve-out 이 아니라 mode(operating/test) 로 한다
//     → lib/userScope.resolveUserScope. (구 isUserInTeamScope/assertCrewIdsInScope 폐지)
//   · 이 모듈은 "어떤 팀이 테스트 팀인가"(팀 레지스트리)만 제공한다 — 팀 목록을 mode 로
//     필터(operating=운영 팀만, test=테스트 팀만)할 때 사용.
// ─────────────────────────────────────────────────────────────────────

// org → 테스트 팀명 집합. 단일 출처(이 상수 외에서 팀명 하드코딩 금지).
export const TEST_TEAM_SCOPE: Readonly<Record<string, ReadonlySet<string>>> = {
  oranke: new Set(["과일(T)", "음료(T)", "콘텐츠실험(T)"]),
  encre: new Set(["사운드(T)", "비주얼랩(T)", "팬덤실험(T)"]),
  phalanx: new Set(["전략(T)", "제품실험(T)", "운영(T)"]),
};

// (org, teamName) 이 테스트 팀인가. 팀 목록 mode 필터에 사용.
export function isTestTeam(organization: string, teamName: string): boolean {
  const set = TEST_TEAM_SCOPE[(organization ?? "").trim()];
  return set ? set.has((teamName ?? "").trim()) : false;
}
