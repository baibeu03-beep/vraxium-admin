// 어드민 테스트 모드 — 테스트 유저 역할 임퍼소네이션 (Phase A 기반).
// ─────────────────────────────────────────────────────────────────────
// 실제 admin 세션(requireAdmin)은 그대로 통과한 상태에서, 기능 게이팅에 쓰는 "액터"를
// 테스트 유저(team_leader/part_leader/agent)로 치환하기 위한 검증 헬퍼.
//
//   · 권한 상승이 아니라 "좁히기 전용" — 유효 권한 = (실 admin 권한) ∩ (임퍼 멤버 스코프).
//   · mode=test + test_user_markers 등재 유저일 때만 활성. operating·실유저·빈값 → 무시(비활성).
//   · DB write 없음(read-only 검증). snapshot/DTO/demoUserId 무관.
//
// 파라미터명: actAsTestUserId (mode=test 와 동반해야 의미). userScope 정책과 직교.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTestUser } from "@/lib/testUsers";
import type { NormalizedMemberRole } from "@/lib/adminMembersTypes";
import type { ScopeMode } from "@/lib/userScopeShared";

export type ImpersonationResult = {
  active: boolean; // 임퍼소네이션 유효 여부
  userId: string | null; // 유효 시 임퍼 대상 test user id (아니면 null)
  requestedId: string | null; // 원 요청값(디버그/로깅용)
  reason: string; // 비활성/활성 사유(로깅용)
};

// mode=test + test_user_markers 등재일 때만 active.
// operating·실유저·빈값 → 비활성(요청은 조용히 무시, 실 admin 컨텍스트 유지).
export async function resolveImpersonation(input: {
  mode: ScopeMode;
  actAsTestUserId: string | null | undefined;
}): Promise<ImpersonationResult> {
  const requestedId = (input.actAsTestUserId ?? "").trim() || null;
  if (!requestedId) {
    return { active: false, userId: null, requestedId: null, reason: "no actAsTestUserId" };
  }
  if (input.mode !== "test") {
    return {
      active: false,
      userId: null,
      requestedId,
      reason: "operating mode — actAsTestUserId ignored",
    };
  }
  // SoT=test_user_markers. 실사용자 id 면 거부(비활성) — 실유저 임퍼소네이션 금지.
  const ok = await isTestUser(requestedId);
  if (!ok) {
    return {
      active: false,
      userId: null,
      requestedId,
      reason: "actAsTestUserId is not a test_user_markers user",
    };
  }
  return { active: true, userId: requestedId, requestedId, reason: "impersonating test user" };
}

// 기능 게이팅에 쓸 "유효 액터 userId" — 임퍼 유효하면 그 id, 아니면 실제 admin id.
//   ⚠ requireAdmin 은 호출부에서 이미 통과한 전제. 이 함수는 actor 컨텍스트만 좁힌다(상승 없음).
export async function resolveEffectiveActorUserId(
  adminUserId: string,
  input: { mode: ScopeMode; actAsTestUserId: string | null | undefined },
): Promise<{ effectiveUserId: string; impersonation: ImpersonationResult }> {
  const impersonation = await resolveImpersonation(input);
  return {
    effectiveUserId: impersonation.active && impersonation.userId ? impersonation.userId : adminUserId,
    impersonation,
  };
}

// ── 서버 write 가드(Phase C) ──────────────────────────────────────────
// 임퍼소네이션 액터(멤버 역할/팀/파트) 기준으로 write 액션 허용 여부 검사.
//   · team_leader : 자기 팀 범위(part_save/open/cancel/review) 전부 허용
//   · part_leader : 자기 팀 + 자기 파트의 part_save 만 허용(open/cancel/review 불가)
//   · agent       : 자기 팀의 review(검수) 만 허용(part_save/open/cancel 불가)
//   · member 등   : 전부 불가
// 위반 시 403 throw(write 전 차단). 권한 상승 아님 — 좁히기 전용.

export type ImpersonationActor = {
  memberRole: NormalizedMemberRole;
  teamName: string | null;
  partName: string | null;
};

export type ExperienceWriteAction = "part_save" | "open" | "cancel" | "review";

const deny403 = (message: string): never => {
  throw Object.assign(new Error(message), { status: 403 });
};

// active=false(임퍼 비활성=owner/admin) 면 가드 미적용(기존 동작 유지).
export function assertImpersonationCapability(input: {
  active: boolean;
  actor: ImpersonationActor;
  action: ExperienceWriteAction;
  targetTeamName: string | null; // ⚠ team_id 에서 해석한 권위 있는 팀명(클라 입력 신뢰 금지)
  targetPart?: string | null;
}): void {
  if (!input.active) return;
  const { actor, action, targetTeamName, targetPart } = input;
  const sameTeam = Boolean(actor.teamName) && actor.teamName === targetTeamName;

  switch (actor.memberRole) {
    case "team_leader":
      if (!sameTeam) deny403("팀장 권한: 자기 팀 범위만 가능합니다.");
      return;
    case "part_leader":
      if (action !== "part_save") deny403("파트장 권한: 개설/검수 권한이 없습니다.");
      if (!sameTeam) deny403("파트장 권한: 자기 팀만 가능합니다.");
      if (!actor.partName || actor.partName !== targetPart)
        deny403("파트장 권한: 자기 파트만 저장할 수 있습니다.");
      return;
    case "agent":
      if (action !== "review") deny403("에이전트 권한: 검수만 가능합니다.");
      if (!sameTeam) deny403("에이전트 권한: 자기 팀 범위만 검수할 수 있습니다.");
      return;
    default:
      deny403("해당 작업 권한이 없습니다.");
  }
}

// team_id → team_name(권위 있는 해석). 가드 비교는 클라 team_name 이 아니라 이 값으로.
//   미존재/조회 실패 → null(가드에서 sameTeam=false → fail-closed).
export async function resolveTeamNameById(teamId: string): Promise<string | null> {
  const id = (teamId ?? "").trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("team_name")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[impersonation] resolveTeamNameById failed", { teamId: id, error: error.message });
    return null;
  }
  return (data as { team_name: string } | null)?.team_name ?? null;
}
