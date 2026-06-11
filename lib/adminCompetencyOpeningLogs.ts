// 실무 역량 라인 개설 "행동 이력" 로그 — 데이터 레이어 (cluster4_competency_opening_logs).
//
// experience 의 lib/adminExperienceOpeningLogs.ts 미러이나 허브 전체 1건 단위라 단순화한다
// (팀/파트/크루상태 없음). 표시값(period_label/actor_name)을 쓰기 시점에 denormalize 로 굳혀,
// 주차/프로필이 바뀌어도 로그만으로 이력을 추적한다.
//
// ⚠ 어드민 메타데이터 — 고객 weekly-cards DTO/스냅샷과 무관. 모든 쓰기는 best-effort(테이블 미생성
//    포함 어떤 실패도 throw 하지 않음 — 라인 개설 본 동작과 분리).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { formatLogPeriodLabel } from "@/lib/practicalInfoSection0Format";
import type { CompetencyOpeningLogAction } from "@/lib/competencyOpeningLogFormat";

export type CompetencyOpeningLogDto = {
  id: string;
  action: CompetencyOpeningLogAction;
  periodLabel: string;
  actorName: string;
  createdAt: string;
};

const LOG_SELECT = "id,action,period_label,actor_name,created_at";

// 실행 어드민 1건의 행동을 기록한다. 표시값을 내부에서 resolve 후 insert.
// best-effort: 어떤 실패도 throw 하지 않는다(테이블 미생성 포함). 본 동작과 분리.
export async function insertCompetencyOpeningLog(input: {
  action: CompetencyOpeningLogAction;
  weekId: string | null;
  organizationSlug: string | null;
  changedBy: string | null;
}): Promise<void> {
  try {
    // 1. 실행자 이름 — user_profiles.display_name.
    let actorName = "관리자";
    if (input.changedBy) {
      const { data: prof } = await supabaseAdmin
        .from("user_profiles")
        .select("display_name")
        .eq("user_id", input.changedBy)
        .maybeSingle();
      const dn = (prof as { display_name: string | null } | null)?.display_name?.trim();
      if (dn) actorName = dn;
    }

    // 2. 기간 라벨(예: 26년 여름 시즌 1주차) — weeks SoT.
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
      .from("cluster4_competency_opening_logs")
      .insert({
        action: input.action,
        week_id: input.weekId,
        organization_slug: input.organizationSlug,
        period_label: periodLabel,
        actor_name: actorName,
        changed_by: input.changedBy,
      });
    if (error) {
      console.warn("[competency-opening-logs] insert skipped:", error.message);
    }
  } catch (e) {
    console.warn(
      "[competency-opening-logs] insert failed (best-effort):",
      e instanceof Error ? e.message : e,
    );
  }
}

// org + 대상 주차 기준 로그 목록(최신순). 테이블 미생성(마이그 전) 등은 빈 목록.
export async function listCompetencyOpeningLogs(options: {
  organization?: string | null;
  weekId?: string | null;
  limit?: number;
}): Promise<CompetencyOpeningLogDto[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  let query = supabaseAdmin
    .from("cluster4_competency_opening_logs")
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
    console.warn("[competency-opening-logs] list unavailable:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    id: string;
    action: CompetencyOpeningLogAction;
    period_label: string;
    actor_name: string;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    action: r.action,
    periodLabel: r.period_label,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
}
