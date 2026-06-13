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

import type { ScopeMode } from "@/lib/userScopeShared";

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

// 팀 목록 스코프 단일 helper — userScope(사용자 포함/제외)의 팀 버전.
// ─────────────────────────────────────────────────────────────────────
// 정책(userScope 와 동일 축):
//   · operating(기본, mode 미지정) : (T) 테스트 팀 제외 → 운영 팀만.
//   · test(mode=test)              : (T) 테스트 팀만 → 운영 팀 제외.
// admin 의 모든 팀 목록 산출 경로(listTeams·cluster4/teams·opening-status·process-check)는
// 화면별 임시 필터 대신 이 함수 하나만 거친다(팀명 하드코딩·중복 분기 금지).
//
// organization 은 단일 org 컨텍스트(모든 admin 팀 목록이 org 스코프). org 미지정(전 org)일 때는
// 각 팀의 organizationSlug 로 판정한다. teamName 만 있으면 충분(ProcessCheckTeamDto 호환).
export function filterTeamsByScope<
  T extends { teamName: string; organizationSlug?: string | null },
>(teams: readonly T[], organization: string | null, mode: ScopeMode): T[] {
  return teams.filter((team) => {
    const org = (organization ?? team.organizationSlug ?? "").trim();
    const isTest = isTestTeam(org, team.teamName);
    return mode === "test" ? isTest : !isTest;
  });
}
