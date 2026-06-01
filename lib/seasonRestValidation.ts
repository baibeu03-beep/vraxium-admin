import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";

// 시즌 전체 휴식 신청 검증 + 실행 — server-only.
//
// 정책:
//   - 시즌 시작 후 1주차까지(start_date + 7일) 신청 가능
//   - 신청 시 해당 시즌 1주차 → personal_rest 전환
//   - 2주차 이후 → 'deadline_passed' 거절

export type SeasonRestResult =
  | { ok: true; seasonKey: string; requestedAt: string }
  | { ok: false; reason: "season_not_found" | "deadline_passed" | "already_rest" | "user_not_found" };

export async function requestSeasonRest(
  userId: string,
  seasonKey: string,
): Promise<SeasonRestResult> {
  // 1. 시즌 정의 조회
  const { data: season } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,start_date")
    .eq("season_key", seasonKey)
    .maybeSingle();

  if (!season) return { ok: false, reason: "season_not_found" };

  // 2. 사용자 존재 확인
  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!profile) return { ok: false, reason: "user_not_found" };

  // 3. 기존 상태 확인
  const { data: existing } = await supabaseAdmin
    .from("user_season_statuses")
    .select("status")
    .eq("user_id", userId)
    .eq("season_key", seasonKey)
    .maybeSingle();

  if (existing?.status === "rest") return { ok: false, reason: "already_rest" };

  // 4. 데드라인 검증 (시즌 시작일 + 7일)
  const startDate = new Date(season.start_date + "T00:00:00Z");
  const deadline = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  if (now > deadline) return { ok: false, reason: "deadline_passed" };

  const requestedAt = now.toISOString();

  // 5. 시즌 상태 upsert → rest
  await supabaseAdmin
    .from("user_season_statuses")
    .upsert(
      {
        user_id: userId,
        season_key: seasonKey,
        status: "rest",
        requested_at: requestedAt,
        note: "시즌 전체 휴식 신청",
      },
      { onConflict: "user_id,season_key" },
    );

  // 6. 해당 시즌 1주차 → personal_rest 전환
  const { data: firstWeek } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id,status")
    .eq("user_id", userId)
    .eq("season_key", seasonKey)
    .order("week_start_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (firstWeek && firstWeek.status === "success") {
    await supabaseAdmin
      .from("user_week_statuses")
      .update({
        status: "personal_rest",
        note: "시즌 전체 휴식으로 인한 1주차 비활동 처리",
      })
      .eq("id", firstWeek.id);

    // 7. growth_stats 재집계
    const { data: weekCounts } = await supabaseAdmin
      .from("user_week_statuses")
      .select("status")
      .eq("user_id", userId);

    const successCount = (weekCounts ?? []).filter(r => r.status === "success").length;
    const totalCount = (weekCounts ?? []).length;

    await supabaseAdmin
      .from("user_growth_stats")
      .update({ approved_weeks: successCount, cumulative_weeks: totalCount })
      .eq("user_id", userId);

    // 쓰기 시점 snapshot 갱신: 1주차가 personal_rest 로 바뀌어 카드가 변하므로 즉시 재계산.
    await refreshWeeklyCardsSnapshotSafe(userId);
  }

  return { ok: true, seasonKey, requestedAt };
}

// 2주차 이후 대안: 남은 주차 일괄 개인 휴식 전환
export async function convertRemainingToPersonalRest(
  userId: string,
  seasonKey: string,
): Promise<{ converted: number }> {
  // 현재 시즌의 미래 주차 중 success/fail → personal_rest 전환
  const today = new Date().toISOString().slice(0, 10);

  const { data: futureWeeks } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id,status")
    .eq("user_id", userId)
    .eq("season_key", seasonKey)
    .gte("week_start_date", today)
    .in("status", ["success", "fail"]);

  if (!futureWeeks || futureWeeks.length === 0) return { converted: 0 };

  const ids = futureWeeks.map(r => r.id);
  await supabaseAdmin
    .from("user_week_statuses")
    .update({
      status: "personal_rest",
      note: "남은 주차 개인 휴식 일괄 전환",
    })
    .in("id", ids);

  // growth_stats 재집계
  const { data: weekCounts } = await supabaseAdmin
    .from("user_week_statuses")
    .select("status")
    .eq("user_id", userId);

  const successCount = (weekCounts ?? []).filter(r => r.status === "success").length;
  const totalCount = (weekCounts ?? []).length;

  await supabaseAdmin
    .from("user_growth_stats")
    .update({ approved_weeks: successCount, cumulative_weeks: totalCount })
    .eq("user_id", userId);

  // 쓰기 시점 snapshot 갱신: 남은 주차가 personal_rest 로 바뀌어 카드가 변하므로 즉시 재계산.
  await refreshWeeklyCardsSnapshotSafe(userId);

  return { converted: ids.length };
}
