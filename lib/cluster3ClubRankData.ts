import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GrowthError } from "@/lib/cluster3GrowthData";
import {
  type ClubRankDto,
  type RankGradeLabel,
  type WeeklyRankDetail,
  resolveRankGrade,
  formatAvgPercentile,
  toGradeNumber,
  toGradeLabel,
} from "@/lib/cluster3GrowthTypes";

// Cluster3 클럽 강화 품계 계산 — server-only.
//
// 계산 흐름:
//   1. user_weekly_points 에서 전 사용자의 주차별 (points, advantages, penalty) 조회
//   2. weekly_score = (points × 1) + (advantages × 3) - (penalty × 5)
//   3. 주차별 RANK (동점 동일 등수, 건너뜀)
//   4. 백분위: 1등=1%, 최하위=100%, 중간 균등 분배
//      total<=1 → 1, else CEIL(((rank-1)/(total-1))*99)+1
//   5. 평균 백분위 = 온보딩 1주차 제외한 주차별 백분위 평균
//   6. 품계 매핑
//
// graduated / suspended 사용자는 user_club_rank_frozen 에서 고정값 반환.

type WeeklyPointRow = {
  user_id: string;
  year: number;
  week_number: number;
  points: number;
  advantages: number;
  penalty: number;
};

type FrozenRow = {
  avg_percentile: number;
  rank_grade: string;
};

type ProfileStatusRow = {
  growth_status: string | null;
};

type UserWeekStatusRow = {
  year: number;
  week_number: number;
};

function computeWeeklyScore(row: { points: number; advantages: number; penalty: number }): number {
  return (row.points * 1) + (row.advantages * 3) - (row.penalty * 5);
}

export async function getClubRank(userId: string): Promise<ClubRankDto> {
  const [profileRes, frozenRes] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("growth_status")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_club_rank_frozen")
      .select("avg_percentile,rank_grade")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  const profile = profileRes.data as ProfileStatusRow | null;
  if (!profile) throw new GrowthError(404, "user_profiles not found");

  const frozen = (frozenRes.data ?? null) as FrozenRow | null;

  if (
    (profile.growth_status === "graduated" || profile.growth_status === "suspended") &&
    frozen
  ) {
    return {
      avgPercentile: Number(frozen.avg_percentile),
      avgPercentileDisplay: `상위 ${formatAvgPercentile(Number(frozen.avg_percentile))}%`,
      rankGrade: frozen.rank_grade,
      isFrozen: true,
      weeklyDetails: [],
    };
  }

  const userFirstWeekRes = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number")
    .eq("user_id", userId)
    .order("year", { ascending: true })
    .order("week_number", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (userFirstWeekRes.error) throw new GrowthError(500, userFirstWeekRes.error.message);
  const firstWeek = userFirstWeekRes.data as UserWeekStatusRow | null;

  // 주차별 RANK 는 전 사용자 대비 상대 순위라 user_weekly_points 전체가 필요하다.
  // Supabase(PostgREST) 기본 1000행 제한을 .range() 페이지네이션으로 우회한다.
  // (전체 row 가 1000 을 넘으면 무제한 select 는 조용히 잘려, 잘린 구간의
  //  사용자는 weeklyDetails 가 비어 avgPercentile=null 이 되고, 남은 사용자의
  //  주차별 totalParticipants/순위도 틀어진다.)
  const allPoints: WeeklyPointRow[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const pageRes = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,year,week_number,points,advantages,penalty")
      .order("year", { ascending: true })
      .order("week_number", { ascending: true })
      .order("user_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (pageRes.error) throw new GrowthError(500, pageRes.error.message);
    const rows = (pageRes.data ?? []) as WeeklyPointRow[];
    allPoints.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  if (allPoints.length === 0) {
    return {
      avgPercentile: null,
      avgPercentileDisplay: "—",
      rankGrade: null,
      isFrozen: false,
      weeklyDetails: [],
    };
  }

  const byWeek = new Map<string, WeeklyPointRow[]>();
  for (const row of allPoints) {
    const key = `${row.year}-${row.week_number}`;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }

  const weeklyDetails: WeeklyRankDetail[] = [];

  for (const [, rows] of byWeek) {
    const scored = rows.map((r) => ({
      userId: r.user_id,
      score: computeWeeklyScore(r),
      year: r.year,
      weekNumber: r.week_number,
    }));

    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const ranks: { userId: string; rank: number }[] = [];
    let currentRank = 1;

    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].score < scored[i - 1].score) {
        currentRank = i + 1;
      }
      ranks.push({ userId: scored[i].userId, rank: currentRank });
    }

    const targetEntry = ranks.find((r) => r.userId === userId);
    if (!targetEntry) continue;

    const targetScored = scored.find((s) => s.userId === userId)!;

    const percentile = total <= 1
      ? 1
      : Math.ceil(((targetEntry.rank - 1) / (total - 1)) * 99) + 1;

    const isOnboarding =
      firstWeek !== null &&
      targetScored.year === firstWeek.year &&
      targetScored.weekNumber === firstWeek.week_number;

    weeklyDetails.push({
      year: targetScored.year,
      weekNumber: targetScored.weekNumber,
      weeklyScore: targetScored.score,
      weeklyRank: targetEntry.rank,
      totalParticipants: total,
      weeklyPercentile: percentile,
      isOnboarding,
    });
  }

  weeklyDetails.sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.weekNumber - b.weekNumber,
  );

  const eligible = weeklyDetails.filter((d) => !d.isOnboarding);

  if (eligible.length === 0) {
    return {
      avgPercentile: null,
      avgPercentileDisplay: "—",
      rankGrade: null,
      isFrozen: false,
      weeklyDetails,
    };
  }

  const sum = eligible.reduce((acc, d) => acc + d.weeklyPercentile, 0);
  const rawAvg = sum / eligible.length;
  const avgPercentile = Math.ceil(rawAvg * 100) / 100;
  const rankGrade = resolveRankGrade(avgPercentile);

  return {
    avgPercentile,
    avgPercentileDisplay: `상위 ${formatAvgPercentile(avgPercentile)}%`,
    rankGrade,
    isFrozen: false,
    weeklyDetails,
  };
}

// ─── user_grade_stats 동기화 ────────────────────────────────────────
//
// getClubRank() 결과를 user_grade_stats 에 UPSERT.
// 기존 데이터 DROP 없이 ON CONFLICT DO UPDATE 방식.

export async function syncGradeStats(userId: string): Promise<{
  avg_percentile: number | null;
  grade: number | null;
  grade_label: string | null;
}> {
  const clubRank = await getClubRank(userId);

  if (clubRank.avgPercentile === null || clubRank.rankGrade === null) {
    return { avg_percentile: null, grade: null, grade_label: null };
  }

  const avgPct = Number(formatAvgPercentile(clubRank.avgPercentile));
  const gradeNum = toGradeNumber(clubRank.rankGrade as RankGradeLabel);
  const gradeLbl = toGradeLabel(clubRank.rankGrade as RankGradeLabel);

  // updated_at 을 명시적으로 넣어야 ON CONFLICT DO UPDATE 시 캐시 신선도가 갱신된다.
  // (Supabase upsert 는 페이로드에 준 컬럼만 UPDATE 하므로, 생략하면 컬럼
  //  DEFAULT now() 는 INSERT 에만 적용되고 갱신 경로에서 updated_at 이 고정된다.)
  const { error } = await supabaseAdmin
    .from("user_grade_stats")
    .upsert(
      {
        user_id: userId,
        avg_percentile: avgPct,
        grade: gradeNum,
        grade_label: gradeLbl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) throw new GrowthError(500, `syncGradeStats failed: ${error.message}`);

  return { avg_percentile: avgPct, grade: gradeNum, grade_label: gradeLbl };
}

export async function syncAllGradeStats(): Promise<{
  synced: number;
  skipped: number;
  results: Array<{ userId: string; avg_percentile: number | null; grade: number | null; grade_label: string | null }>;
}> {
  const { data: users, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .not("organization_slug", "is", null);

  if (error) throw new GrowthError(500, error.message);
  if (!users || users.length === 0) return { synced: 0, skipped: 0, results: [] };

  const results: Array<{ userId: string; avg_percentile: number | null; grade: number | null; grade_label: string | null }> = [];
  let synced = 0;
  let skipped = 0;

  for (const user of users as Array<{ user_id: string }>) {
    try {
      const result = await syncGradeStats(user.user_id);
      if (result.grade !== null) {
        synced++;
      } else {
        skipped++;
      }
      results.push({ userId: user.user_id, ...result });
    } catch {
      skipped++;
      results.push({ userId: user.user_id, avg_percentile: null, grade: null, grade_label: null });
    }
  }

  return { synced, skipped, results };
}

// ─── app-level 캐시 동기화 오케스트레이터 ────────────────────────────
//
// user_weekly_points 변경(seed/script/admin API) 직후 호출한다.
// DB 트리거가 아니라 app-level 에서 순서를 명시적으로 보장한다.
//
// 순서:
//   1) cumulative points 재계산
//      user_weekly_points 쓰기는 DB 트리거 sync_cumulative_on_weekly_change 가
//      같은 트랜잭션에서 user_cumulative_points 를 동기화한다. 다만 트리거 우회
//      경로(bulk COPY, 트리거 미설치 환경 등)에 대비해, 변경된 user_id 가 주어지면
//      sync_cumulative_points_for_user RPC 로 한 번 더 명시적으로 재계산한다.
//      (RPC 는 weekly 합계를 다시 UPSERT 하므로 idempotent.)
//   2) grade stats 재계산
//      품계는 "상대" 백분위 기반이라 한 사용자만 갱신하면 나머지 사용자의 주차별
//      순위·총원이 틀어진다. 반드시 syncAllGradeStats() 로 전체 사용자를 재계산한다.

export type GrowthCacheSyncResult = {
  cumulativeResynced: number;
  gradeStats: Awaited<ReturnType<typeof syncAllGradeStats>>;
};

export async function syncGrowthCachesAfterPointsChange(
  options: { affectedUserIds?: string[] } = {},
): Promise<GrowthCacheSyncResult> {
  const affectedUserIds = options.affectedUserIds ?? [];

  // 1) cumulative 재계산 (변경된 사용자만 — 명시적 순서 보장)
  let cumulativeResynced = 0;
  for (const userId of affectedUserIds) {
    const { error } = await supabaseAdmin.rpc("sync_cumulative_points_for_user", {
      p_user_id: userId,
    });
    if (error) {
      throw new GrowthError(
        500,
        `cumulative resync failed for ${userId}: ${error.message}`,
      );
    }
    cumulativeResynced++;
  }

  // 2) grade stats 전체 재계산 (상대 백분위 → 전체 사용자 필수)
  const gradeStats = await syncAllGradeStats();

  return { cumulativeResynced, gradeStats };
}
