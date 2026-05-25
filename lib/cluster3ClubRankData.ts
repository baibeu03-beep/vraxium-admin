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

  const allPointsRes = await supabaseAdmin
    .from("user_weekly_points")
    .select("user_id,year,week_number,points,advantages,penalty");

  if (allPointsRes.error) throw new GrowthError(500, allPointsRes.error.message);
  const allPoints = (allPointsRes.data ?? []) as WeeklyPointRow[];

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

  const { error } = await supabaseAdmin
    .from("user_grade_stats")
    .upsert(
      {
        user_id: userId,
        avg_percentile: avgPct,
        grade: gradeNum,
        grade_label: gradeLbl,
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
