// Server-only data layer: user_growth_stats(approved_weeks/cumulative_weeks)
// 단일 사용자 재집계.
//
// 표준 정의(2026-06-04 전환제외 정책 반영 — 이력서 seasonRecords·weekly-status summary·
// season-participations 집계·cluster4 growthSummary 와 동일 기준):
//   - approved_weeks   = user_week_statuses 중 status='success' 인 row 수, 전환 주차 제외
//                        (공식 휴식 override 는 status 가 'success' 로 저장되므로 자동 포함)
//   - cumulative_weeks = user_week_statuses 전체 row 수, 전환 주차 제외 (official_rest 포함)
//
// 전환 주차 판정은 isTransitionWeekStart(week_start_date) — 다른 모든 화면과 동일 함수.
// (종전 공식은 전환 주차를 포함해 weekly-status total_weeks 와 분기했었다.)
//
// 참조(종전 공식·시드 시점):
//   db/migrations/2026-05-25_cluster3_growth_indicators.sql (INSERT … COUNT(*) FILTER(success), COUNT(*))
//   db/migrations/2026-05-25_season_rest_request_policy.sql  (approved=success_count, cumulative=total_count)
//   db/migrations/2026-05-25_official_rest_weeks_and_override.sql (approved=success_count, cumulative 변동 없음)
//
// user_growth_stats 의 grade/avg_percentile/grade_label 은 nullable 이므로 (user_id,
// approved_weeks, cumulative_weeks) 만 upsert 해도 NOT NULL 위반이 없다. user_id 는
// unique(ON CONFLICT (user_id)) 이므로 onConflict 로 UPSERT 한다 — row 가 없으면 생성.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";

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
  //    전환 주차는 양쪽 카운트 모두에서 제외 (2026-06-04 전환제외 정책).
  const { data, error } = await supabaseAdmin
    .from("user_week_statuses")
    .select("status, week_start_date")
    .eq("user_id", id);

  if (error) {
    throw new UserGrowthStatsRecalcError(error.message);
  }

  const rows = (
    (data ?? []) as { status: string; week_start_date: string | null }[]
  ).filter(
    (r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date)),
  );
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

// 여러 사용자 성장 캐시를 제한 동시성으로 병렬 재계산한다(검수 완료/실행 취소의 직렬 for-await 대체).
//   - 사용자별 실패는 격리(로그+계속) — best-effort. 전체가 throw 하지 않는다(본 요청 응답 보호).
//   - 각 호출이 저렴(1 SELECT + 1 UPSERT ≈ 100ms)해 직렬이면 N 배 누적된다 → 병렬로 벽시계 단축.
//   - concurrency 기본 8 (lib DB 포화 가드 상한과 동일). 빈/중복 id 는 정리.
export async function recalcUserGrowthStatsForUsers(
  userIds: string[],
  opts: { concurrency?: number } = {},
): Promise<{ requested: number; recalculated: number; failed: number; failedUserIds: string[] }> {
  const uniqueIds = Array.from(
    new Set(userIds.filter((id): id is string => Boolean(id && String(id).trim()))),
  );
  if (uniqueIds.length === 0) {
    return { requested: 0, recalculated: 0, failed: 0, failedUserIds: [] };
  }
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const failedUserIds: string[] = [];
  let recalculated = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < uniqueIds.length) {
      const uid = uniqueIds[cursor++];
      try {
        await recalcUserGrowthStats(uid);
        recalculated++;
      } catch (e) {
        failedUserIds.push(uid);
        console.warn("[user-growth-stats] batch recalc failed (isolated)", {
          userId: uid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()),
  );

  return {
    requested: uniqueIds.length,
    recalculated,
    failed: failedUserIds.length,
    failedUserIds,
  };
}
