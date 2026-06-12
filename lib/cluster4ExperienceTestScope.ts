// 실무 경험 라인 개설 — 테스트 팀/파트 스코프 안전장치(단일 SoT).
// ─────────────────────────────────────────────────────────────────────
// 테스터 90명 가상 팀/파트/역할 재배치(2026-06-12) 이후, 아래 9개 (org, 팀명) 만
// "테스트 팀"이다. 재배치 시 팀명은 "(T)" 접미사로 시드되었다
// (backups/seed90-test-team-reassignment-2026-06-12T09-50-19-831Z.json).
//
// 노출/저장/개설 대상 정책:
//   · 테스트 팀 : test_user_markers 등재 유저만 (실사용자가 섞여 있어도 제외).
//   · 운영 팀   : test_user_markers 등재 유저 제외 (기존 동작 유지).
//
// 팀 식별은 (organization_slug, user_memberships.team_name == cluster4_teams.team_name)
// 정확 일치. 휴리스틱("(T)" 접미사) 이 아니라 명시 allowlist 를 쓴다 — 운영 팀이
// 우연히 매칭돼 실사용자가 가려지는 사고를 원천 차단(fail-safe).
//
// 데모/스냅샷 무관: 이 모듈은 목록 필터(read)와 write 직전 검증(write-time guard)만
// 담당한다. snapshot-only 조회 구조·demoUserId 경로·DTO 는 건드리지 않는다.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

// org → 테스트 팀명 집합. 단일 출처(이 상수 외에서 팀명 하드코딩 금지).
export const TEST_TEAM_SCOPE: Readonly<Record<string, ReadonlySet<string>>> = {
  oranke: new Set(["과일(T)", "음료(T)", "콘텐츠실험(T)"]),
  encre: new Set(["사운드(T)", "비주얼랩(T)", "팬덤실험(T)"]),
  phalanx: new Set(["전략(T)", "제품실험(T)", "운영(T)"]),
};

// (org, teamName) 이 테스트 팀인가.
export function isTestTeam(organization: string, teamName: string): boolean {
  const set = TEST_TEAM_SCOPE[(organization ?? "").trim()];
  return set ? set.has((teamName ?? "").trim()) : false;
}

// 단일 유저가 (org, teamName) 의 노출/대상 스코프에 부합하는가.
//   테스트 팀: test_user_markers 등재 유저만 true.
//   운영 팀  : test_user_markers 비등재 유저만 true.
export function isUserInTeamScope(
  organization: string,
  teamName: string,
  userId: string,
  testUserIds: ReadonlySet<string>,
): boolean {
  return isTestTeam(organization, teamName)
    ? testUserIds.has(userId)
    : !testUserIds.has(userId);
}

// teamId(cluster4_teams.id) → team_name. write 검증에서 teamName 만 받는 경로(part 저장)용.
// is_active 무관(유효 id 면 비활성이어도 해석). 미존재 시 null.
export async function resolveTeamName(teamId: string): Promise<string | null> {
  const id = (teamId ?? "").trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("team_name")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[testScope] resolveTeamName failed", { teamId: id, error: error.message });
    return null;
  }
  return (data as { team_name: string } | null)?.team_name ?? null;
}

// write 직전 검증: userIds 전원이 (org, teamName) 스코프에 부합해야 한다.
// 하나라도 벗어나면(테스트 팀에 실사용자 / 운영 팀에 테스트 계정) throw → 호출부 write 중단.
// status=422 부여(라우트가 error.status 를 읽으면 그대로 응답).
export async function assertCrewIdsInScope(
  organization: string,
  teamName: string,
  userIds: ReadonlyArray<string>,
): Promise<void> {
  const unique = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return;

  const testUserIds = await fetchTestUserMarkerIds();
  const offenders = unique.filter(
    (id) => !isUserInTeamScope(organization, teamName, id, testUserIds),
  );
  if (offenders.length === 0) return;

  const test = isTestTeam(organization, teamName);
  const msg = test
    ? `테스트 팀(${teamName})에는 테스트 계정만 대상이 될 수 있습니다 — 실사용자 ${offenders.length}명이 포함되어 처리를 중단했습니다.`
    : `운영 팀(${teamName})에는 테스트 계정을 포함할 수 없습니다 — 테스트 계정 ${offenders.length}명이 포함되어 처리를 중단했습니다.`;
  throw Object.assign(new Error(msg), { status: 422 });
}
