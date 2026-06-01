// Server-only data layer: user_growth_stats(approved_weeks/cumulative_weeks)
// 단일 사용자 재집계.
//
// 표준 정의(아래 3곳의 마이그레이션에서 동일하게 사용되는 SoT 공식):
//   - approved_weeks   = user_week_statuses 중 status='success' 인 row 수
//                        (공식 휴식 override 는 status 가 'success' 로 저장되므로 자동 포함)
//   - cumulative_weeks = user_week_statuses 전체 row 수 (official_rest 포함, 제외하지 않음)
//
// 참조:
//   db/migrations/2026-05-25_cluster3_growth_indicators.sql (INSERT … COUNT(*) FILTER(success), COUNT(*))
//   db/migrations/2026-05-25_season_rest_request_policy.sql  (approved=success_count, cumulative=total_count)
//   db/migrations/2026-05-25_official_rest_weeks_and_override.sql (approved=success_count, cumulative 변동 없음)
//
// user_growth_stats 의 grade/avg_percentile/grade_label 은 nullable 이므로 (user_id,
// approved_weeks, cumulative_weeks) 만 upsert 해도 NOT NULL 위반이 없다. user_id 는
// unique(ON CONFLICT (user_id)) 이므로 onConflict 로 UPSERT 한다 — row 가 없으면 생성.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type UserGrowthStatsValues = {
  approved_weeks: number;
  cumulative_weeks: number;
};

export class UserGrowthStatsRecalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserGrowthStatsRecalcError";
  }
}

// user_week_statuses 를 기준으로 단일 사용자의 user_growth_stats 캐시를 재집계한다.
// 성공 시 갱신된 값을 반환한다.
export async function recalcUserGrowthStats(
  userId: string,
): Promise<UserGrowthStatsValues> {
  const id = String(userId ?? "").trim();
  if (!id) {
    throw new UserGrowthStatsRecalcError("userId is required.");
  }

  // 1) 기준 집계 — 사용자의 모든 주차 상태를 읽어 success / 전체 수를 센다.
  const { data, error } = await supabaseAdmin
    .from("user_week_statuses")
    .select("status")
    .eq("user_id", id);

  if (error) {
    throw new UserGrowthStatsRecalcError(error.message);
  }

  const rows = (data ?? []) as { status: string }[];
  const cumulative_weeks = rows.length;
  const approved_weeks = rows.filter((r) => r.status === "success").length;

  // 2) 캐시 UPSERT — grade 등 다른 컬럼은 건드리지 않는다.
  const { error: upsertError } = await supabaseAdmin
    .from("user_growth_stats")
    .upsert(
      { user_id: id, approved_weeks, cumulative_weeks },
      { onConflict: "user_id" },
    );

  if (upsertError) {
    throw new UserGrowthStatsRecalcError(upsertError.message);
  }

  return { approved_weeks, cumulative_weeks };
}
