// 실무 정보 라인 개설 [섹션 0] 로그창 — 라인 개설/취소 이력(append-only) 데이터 레이어.
//
// cluster4_line_opening_logs 테이블만 읽고 쓴다. 표시값(activity_label/period_label/actor_name)을
// 쓰기 시점에 denormalized 로 굳혀, 라인/주차가 삭제돼도 로그만으로 이력을 추적할 수 있게 한다.
//
// ⚠ 어드민 메타데이터 — 고객 weekly-cards DTO/스냅샷 계산과 무관하다. 본 모듈은 snapshot
//   invalidate/recompute 를 일절 호출하지 않으며, 모든 쓰기는 best-effort(실패해도 라인 open/cancel
//   본 동작을 깨지 않는다 — user_growth_status_audit 패턴).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAdminDisplayName } from "@/lib/adminMe";
import {
  formatLogPeriodLabel,
  type OpeningLogAction,
} from "@/lib/practicalInfoSection0Format";

export type OpeningLogDto = {
  id: string;
  action: OpeningLogAction;
  activityTypeId: string | null;
  activityLabel: string;
  periodLabel: string;
  actorName: string;
  createdAt: string;
};

const LOG_SELECT =
  "id,action,activity_type_id,activity_label,period_label,actor_name,created_at";

// 라인 1건의 개설/취소 이벤트를 기록한다. 표시 라벨/실행자명을 내부에서 resolve 후 insert.
// best-effort: 어떤 실패도 throw 하지 않는다(테이블 미생성 포함). 라인 본 동작과 분리.
export async function insertOpeningLogForLine(input: {
  action: OpeningLogAction;
  lineId: string | null;
  weekId: string | null;
  activityTypeId: string | null;
  changedBy: string | null;
}): Promise<void> {
  try {
    // 1. 활동유형 라벨(예: 위즈덤).
    let activityLabel = input.activityTypeId ?? "-";
    if (input.activityTypeId) {
      const { data } = await supabaseAdmin
        .from("activity_types")
        .select("name")
        .eq("id", input.activityTypeId)
        .maybeSingle();
      const name = (data as { name: string | null } | null)?.name;
      if (name && name.trim().length > 0) activityLabel = name.trim();
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

    // 3. 실행자명(예: 홍길동). display_name 없으면 "관리자".
    let actorName = "관리자";
    if (input.changedBy) {
      const name = await loadAdminDisplayName(input.changedBy).catch(() => null);
      if (name && name.trim().length > 0) actorName = name.trim();
    }

    const { error } = await supabaseAdmin
      .from("cluster4_line_opening_logs")
      .insert({
        action: input.action,
        line_id: input.lineId,
        week_id: input.weekId,
        activity_type_id: input.activityTypeId,
        activity_label: activityLabel,
        period_label: periodLabel,
        changed_by: input.changedBy,
        actor_name: actorName,
      });
    if (error) {
      console.warn("[opening-logs] insert skipped:", error.message);
    }
  } catch (e) {
    console.warn(
      "[opening-logs] insert failed (best-effort):",
      e instanceof Error ? e.message : e,
    );
  }
}

// 현재 활동유형 기준 로그 목록(최신순). info=common 이라 organization 은 결과에 영향 없음(수용만).
export async function listOpeningLogs(options: {
  activityTypeId: string;
  organization?: string | null;
  limit?: number;
}): Promise<OpeningLogDto[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_opening_logs")
    .select(LOG_SELECT)
    .eq("activity_type_id", options.activityTypeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    // 테이블 미생성(마이그레이션 전) 등 — 빈 목록으로 진행.
    console.warn("[opening-logs] list unavailable:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    id: string;
    action: OpeningLogAction;
    activity_type_id: string | null;
    activity_label: string;
    period_label: string;
    actor_name: string;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    action: r.action,
    activityTypeId: r.activity_type_id,
    activityLabel: r.activity_label,
    periodLabel: r.period_label,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
}
