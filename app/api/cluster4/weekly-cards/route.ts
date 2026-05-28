import type { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  AdminAuthError,
  requireAdmin,
} from "@/lib/adminAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  Cluster4WeeklyCardsError,
  getCluster4WeeklyCardsForAuthUser,
  getCluster4WeeklyCardsForProfileUser,
} from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// 디버깅: W12/W11 에 대해 백엔드(getWeeklyGrowth) ↔ DTO 응답값 매핑을 콘솔에 비교 출력.
// 프론트 검증용 ad-hoc 로그 — 운영에서도 비용 무시 가능 (2개 row 만).
async function logWeekComparison(
  profileUserId: string,
  cards: Cluster4WeeklyCardDto[],
): Promise<void> {
  try {
    const growth = await getWeeklyGrowth(profileUserId);
    if (!growth) return;

    for (const weekNum of [12, 11]) {
      const backend = growth.weeklyCards.find((c) => c.weekNumber === weekNum);
      const dto = cards.find((c) => c.weekNumber === weekNum);
      if (!backend || !dto) continue;
      console.log(
        `[cluster4/weekly-cards W${weekNum} compare]`,
        JSON.stringify(
          {
            backend: {
              teamLabel: backend.teamLabel,
              partLabel: backend.partLabel,
              activityStatus: backend.activityStatus,
              points: backend.pointsRaw,
              advantages: backend.advantagesRaw,
              penalty: backend.penaltyRaw,
              cumulativeAdvantages: backend.cumulativeAdvantages,
              totalFmScore: backend.totalFmScoreRaw,
              weeklyReputationCount: backend.weeklyReputationCountRaw,
              linkedCrewCount: backend.linkedCrewCountRaw,
              weeklyGrowthRate: backend.weeklyGrowth.rate,
              growth: `${backend.weeklyGrowth.completedLines}/${backend.weeklyGrowth.availableLines}`,
              lineBreakdown: backend.lineBreakdown,
            },
            dto: {
              teamName: dto.teamName,
              partName: dto.partName,
              roleLabel: dto.roleLabel,
              membershipStatusLabel: dto.membershipStatusLabel,
              points: dto.points,
              cumulativeInjeolmi: dto.cumulativeInjeolmi,
              fameScore: dto.fameScore,
              reputationCount: dto.reputationCount,
              reputationTotal: dto.reputationTotal,
              colleagueCount: dto.colleagueCount,
              colleagueTotal: dto.colleagueTotal,
              weeklyGrowthRate: dto.weeklyGrowthRate,
              growth: `${dto.growthNumerator}/${dto.growthDenominator}`,
              lines: dto.lines.map((l) => ({
                partType: l.partType,
                numerator: l.numerator,
                denominator: l.denominator,
                rate: l.rate,
              })),
            },
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.warn("[cluster4/weekly-cards W12/W11 compare] failed", error);
  }
}

export async function GET(request: NextRequest) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json(
      { success: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const requestedUserId =
      request.nextUrl.searchParams.get("userId")?.trim() || null;

    let data;
    let profileUserIdForLog: string | null = null;
    if (requestedUserId) {
      const ownProfileUserId = await resolveProfileUserId(user.id, user.email);
      if (requestedUserId !== ownProfileUserId) {
        await requireAdmin(ADMIN_READ_ROLES);
      }
      data = await getCluster4WeeklyCardsForProfileUser(requestedUserId);
      profileUserIdForLog = requestedUserId;
    } else {
      data = await getCluster4WeeklyCardsForAuthUser(
        user.id,
        user.email ?? null,
      );
      profileUserIdForLog = await resolveProfileUserId(user.id, user.email);
    }

    if (profileUserIdForLog) {
      await logWeekComparison(profileUserIdForLog, data);
    }

    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }

    if (error instanceof Cluster4WeeklyCardsError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }

    console.error("[cluster4/weekly-cards GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load cluster4 weekly cards.",
      },
      { status: 500 },
    );
  }
}
