// 실무 경험 라인 개설 "행동 이력" 로그 — 데이터 레이어 (cluster4_experience_opening_logs).
//
// practical-info 의 lib/adminCluster4OpeningLogs.ts 미러. 표시값(period_label/team_name/part_name/
// actor_crew_status/actor_name)을 쓰기 시점에 denormalize 로 굳혀, 라인/주차/프로필이 바뀌어도
// 로그만으로 이력을 추적한다.
//
// 실행 팀/파트/크루상태/사람 = "실행한 어드민 계정"의 크루 소속 기준(결정 정책).
//   - 실행자 user_profiles 에 팀/파트가 없으면 → insert 스킵 + console.warn (권한/프로필 설정 오류).
//     "소속 없음" 행은 만들지 않는다.
//
// ⚠ 어드민 메타데이터 — 고객 weekly-cards DTO/스냅샷과 무관. snapshot invalidate/recompute 무호출.
//    모든 쓰기는 best-effort(어떤 실패도 throw 하지 않음 — 라인 개설 본 동작과 분리).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  memberStatusLabel,
  normalizeMemberRole,
  type NormalizedMemberRole,
} from "@/lib/adminMembersTypes";
import { resolveTeamNameById } from "@/lib/experienceImpersonation";
import { formatLogPeriodLabel } from "@/lib/practicalInfoSection0Format";
import type { ExperienceOpeningLogAction } from "@/lib/experienceOpeningLogFormat";

// 팀 단위(검수/완료/취소) 실행 시 파트 표기. 파트장 신청/취소는 실제 파트명을 그대로 쓴다.
export const EXPERIENCE_LOG_TEAM_OVERALL_PART_LABEL = "팀 총괄";

// 파트 신청 헤더는 [신청 취소]에서 삭제되므로, 취소 후 다시 신청하는 경우의 "이전 신청 이력"은
// append-only 로그의 구조화 action 으로 확인한다. 레거시 Draft 로그(draft_id 있음)는 제외한다.
// 조회 실패 시 false 로 폴백하며 라인 개설 mutation 자체에는 영향을 주지 않는다.
export async function hasPriorExperiencePartApplicationLog(input: {
  weekId: string;
  organizationSlug: string;
  teamId: string;
  partName: string;
}): Promise<boolean> {
  try {
    const teamName = await resolveTeamNameById(input.teamId).catch(() => null);
    if (!teamName) return false;
    const { count, error } = await supabaseAdmin
      .from("cluster4_experience_opening_logs")
      .select("id", { count: "exact", head: true })
      .eq("week_id", input.weekId)
      .eq("organization_slug", input.organizationSlug)
      .eq("team_name", teamName)
      .eq("part_name", input.partName)
      .is("draft_id", null)
      .in("action", ["apply", "reapply"]);
    if (error) {
      console.warn("[experience-opening-logs] prior application lookup skipped:", error.message);
      return false;
    }
    return (count ?? 0) > 0;
  } catch (error) {
    console.warn(
      "[experience-opening-logs] prior application lookup failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

// 실행한 크루 상태 라벨(로그 표기 규칙 — 고정 스펙):
//   파트장 → 심화크루(파트장) · 에이전트 → 심화크루(에이전트) · 팀장 → 팀장.
//   정규 3역할 밖(운영자/최고관리자 등, 임퍼소네이션 없이 실행)은 등급 라벨로 폴백(빈칸 방지).
function experienceLogActorCrewStatus(
  memberRole: NormalizedMemberRole,
  role: string | null,
  membershipLevel: string | null,
): string {
  switch (memberRole) {
    case "part_leader":
      return "심화크루(파트장)";
    case "agent":
      return "심화크루(에이전트)";
    case "team_leader":
      return "팀장";
    default:
      return memberStatusLabel(role, membershipLevel);
  }
}

export type ExperienceOpeningLogDto = {
  id: string;
  action: ExperienceOpeningLogAction;
  periodLabel: string;
  teamName: string | null;
  partName: string | null;
  actorCrewStatus: string | null;
  actorName: string;
  createdAt: string;
};

const LOG_SELECT =
  "id,action,period_label,team_name,part_name,actor_crew_status,actor_name,created_at";

// 실행 1건의 행동을 기록한다. 표시값(팀/파트/크루상태/이름/기간)을 내부에서 resolve 후 denormalize insert.
// best-effort: 어떤 실패도 throw 하지 않는다(테이블 미생성 포함). 라인 개설 본 동작과 분리.
//
// ⚠ org/mode 무관 단일 경로. 표기 규칙:
//   · 실행한 사람/크루상태 = actorUserId(임퍼소네이션 유효 시 그 테스트 유저, 아니면 실 admin) 기준.
//   · 실행 팀 = teamId(권위 해석) 우선, 없으면 teamName override.
//   · 실행 파트 = 팀 단위(검수/완료/취소, isTeamLevel=true) → "팀 총괄" · 파트 단위(신청/취소) → partName.
// 과거처럼 "실행자 프로필에 팀/파트 없으면 스킵"하지 않는다(팀/파트는 행동 컨텍스트에서 확정).
export async function insertExperienceOpeningLog(input: {
  action: ExperienceOpeningLogAction;
  weekId: string | null;
  organizationSlug: string | null;
  // 실행한 유효 액터(파트장/에이전트/팀장 = 임퍼 대상, 없으면 실 admin). 이름·역할·크루상태 SoT.
  actorUserId: string | null;
  // 실행 팀 — team_id(권위) 우선 해석. 없으면 teamName 사용.
  teamId?: string | null;
  teamName?: string | null;
  // 실행 파트 — 파트 단위면 파트명. 팀 단위(검수/완료/취소)는 isTeamLevel=true → "팀 총괄".
  partName?: string | null;
  isTeamLevel?: boolean;
  // 메타(옵션).
  draftId?: string | null;
  targetUserId?: string | null;
}): Promise<void> {
  try {
    // 1. 실행 액터(role/등급/이름) — user_profiles + user_memberships(현재행).
    let role: string | null = null;
    let membershipLevel: string | null = null;
    let actorName = "관리자";
    if (input.actorUserId) {
      const { data: prof } = await supabaseAdmin
        .from("user_profiles")
        .select("display_name,role")
        .eq("user_id", input.actorUserId)
        .maybeSingle();
      const p = prof as {
        display_name: string | null;
        role: string | null;
      } | null;
      if (p) {
        role = p.role;
        const dn = p.display_name?.trim();
        if (dn) actorName = dn;
      }
      const { data: mems } = await supabaseAdmin
        .from("user_memberships")
        .select("membership_level,is_current")
        .eq("user_id", input.actorUserId);
      const rows = (mems ?? []) as Array<{
        membership_level: string | null;
        is_current: boolean | null;
      }>;
      const chosen = rows.find((r) => r.is_current) ?? rows[0] ?? null;
      membershipLevel = chosen?.membership_level ?? null;
    }
    const memberRole = normalizeMemberRole(role, membershipLevel);
    const actorCrewStatus = experienceLogActorCrewStatus(
      memberRole,
      role,
      membershipLevel,
    );

    // 2. 실행 팀 — team_id 권위 해석 우선, 실패 시 teamName override.
    let teamName: string | null = input.teamName?.trim() || null;
    if (input.teamId) {
      const resolved = await resolveTeamNameById(input.teamId).catch(() => null);
      if (resolved) teamName = resolved;
    }

    // 3. 실행 파트 — 팀 단위 → "팀 총괄", 파트 단위 → 파트명.
    const partName = input.isTeamLevel
      ? EXPERIENCE_LOG_TEAM_OVERALL_PART_LABEL
      : input.partName?.trim() || null;

    // 4. 기간 라벨(예: 26년 여름 시즌 1주차) — weeks SoT.
    let periodLabel = "기간 미상";
    if (input.weekId) {
      const { data } = await supabaseAdmin
        .from("weeks")
        .select("iso_year,season_key,week_number")
        .eq("id", input.weekId)
        .maybeSingle();
      const w = data as {
        iso_year: number | null;
        season_key: string | null;
        week_number: number | null;
      } | null;
      if (w) {
        periodLabel = formatLogPeriodLabel({
          isoYear: w.iso_year,
          seasonKey: w.season_key,
          weekNumber: w.week_number,
        });
      }
    }

    const { error } = await supabaseAdmin
      .from("cluster4_experience_opening_logs")
      .insert({
        action: input.action,
        draft_id: input.draftId ?? null,
        week_id: input.weekId,
        target_user_id: input.targetUserId ?? null,
        organization_slug: input.organizationSlug,
        period_label: periodLabel,
        team_name: teamName,
        part_name: partName,
        actor_crew_status: actorCrewStatus,
        actor_name: actorName,
        changed_by: input.actorUserId,
      });
    if (error) {
      console.warn("[experience-opening-logs] insert skipped:", error.message);
    }
  } catch (e) {
    console.warn(
      "[experience-opening-logs] insert failed (best-effort):",
      e instanceof Error ? e.message : e,
    );
  }
}

// org + 대상 주차 기준 로그 목록(최신순). 테이블 미생성(마이그 전) 등은 빈 목록.
export async function listExperienceOpeningLogs(options: {
  organization?: string | null;
  weekId?: string | null;
  limit?: number;
}): Promise<ExperienceOpeningLogDto[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  let query = supabaseAdmin
    .from("cluster4_experience_opening_logs")
    .select(LOG_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (options.organization) {
    query = query.eq("organization_slug", options.organization);
  }
  if (options.weekId) {
    query = query.eq("week_id", options.weekId);
  }
  const { data, error } = await query;
  if (error) {
    console.warn("[experience-opening-logs] list unavailable:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    id: string;
    action: ExperienceOpeningLogAction;
    period_label: string;
    team_name: string | null;
    part_name: string | null;
    actor_crew_status: string | null;
    actor_name: string;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    action: r.action,
    periodLabel: r.period_label,
    teamName: r.team_name,
    partName: r.part_name,
    actorCrewStatus: r.actor_crew_status,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
}
