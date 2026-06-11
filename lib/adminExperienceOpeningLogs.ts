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
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { formatLogPeriodLabel } from "@/lib/practicalInfoSection0Format";
import type { ExperienceOpeningLogAction } from "@/lib/experienceOpeningLogFormat";

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

// 실행 어드민 1건의 행동을 기록한다. 표시값을 내부에서 resolve 후 insert.
// best-effort: 어떤 실패도 throw 하지 않는다(테이블 미생성 포함). 본 동작과 분리.
export async function insertExperienceOpeningLog(input: {
  action: ExperienceOpeningLogAction;
  draftId: string | null;
  weekId: string | null;
  organizationSlug: string | null;
  targetUserId: string | null;
  changedBy: string | null;
}): Promise<void> {
  try {
    // 1. 실행자 소속(팀/파트/role/이름) — user_profiles.
    let teamName: string | null = null;
    let partName: string | null = null;
    let role: string | null = null;
    let actorName = "관리자";
    if (input.changedBy) {
      const { data: prof } = await supabaseAdmin
        .from("user_profiles")
        .select("display_name,current_team_name,current_part_name,role")
        .eq("user_id", input.changedBy)
        .maybeSingle();
      const p = prof as {
        display_name: string | null;
        current_team_name: string | null;
        current_part_name: string | null;
        role: string | null;
      } | null;
      if (p) {
        teamName = p.current_team_name?.trim() || null;
        partName = p.current_part_name?.trim() || null;
        role = p.role;
        const dn = p.display_name?.trim();
        if (dn) actorName = dn;
      }
    }

    // 정책: 실행자 팀/파트가 없으면 로그 미기록(권한/프로필 설정 오류로 취급).
    if (!teamName || !partName) {
      console.warn(
        "[experience-opening-logs] insert skipped — actor has no team/part (permission/profile error):",
        { changedBy: input.changedBy, action: input.action },
      );
      return;
    }

    // 2. 실행자 멤버십 등급(user_memberships) → 크루 상태 라벨.
    let membershipLevel: string | null = null;
    if (input.changedBy) {
      const { data: mems } = await supabaseAdmin
        .from("user_memberships")
        .select("membership_level,is_current")
        .eq("user_id", input.changedBy);
      const rows = (mems ?? []) as Array<{
        membership_level: string | null;
        is_current: boolean | null;
      }>;
      const chosen = rows.find((r) => r.is_current) ?? rows[0] ?? null;
      membershipLevel = chosen?.membership_level ?? null;
    }
    const actorCrewStatus = memberStatusLabel(role, membershipLevel);

    // 3. 기간 라벨(예: 26년 여름 시즌 1주차) — weeks SoT.
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
        draft_id: input.draftId,
        week_id: input.weekId,
        target_user_id: input.targetUserId,
        organization_slug: input.organizationSlug,
        period_label: periodLabel,
        team_name: teamName,
        part_name: partName,
        actor_crew_status: actorCrewStatus,
        actor_name: actorName,
        changed_by: input.changedBy,
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
