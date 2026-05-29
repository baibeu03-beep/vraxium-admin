// Cluster3 stats-cards — server-only DTO 빌더.
//
// SoT: getGrowthIndicators() 단일 실시간 계산식을 그대로 재사용한다.
// 어드민 GET /api/admin/crews/[id]/cluster3/growth 와 동일 함수를 거치므로
// 어드민 화면과 항상 같은 값을 반환한다 (계산식 중복 없음).
//
// 본 모듈은 getGrowthIndicators() 의 GrowthIndicatorsDto 를
// 프론트 친화적 Cluster3StatsCards 형태로 매핑만 수행한다 (재계산 없음).

import { getGrowthIndicators } from "@/lib/cluster3GrowthData";
import type { Cluster3StatsCards } from "@/lib/cluster3StatsCardsTypes";

export async function getCluster3StatsCards(
  userId: string,
): Promise<Cluster3StatsCards> {
  const g = await getGrowthIndicators(userId);

  const isBeCluving = g.process.activityEndedAt === null;

  return {
    userId: g.userId,
    organizationSlug: g.organizationSlug,
    process: {
      growthStatus: g.process.growthStatusDisplay,
      growthStatusKey: g.process.growthDisplayKey,
      growthStatusRaw: g.process.growthStatus,
      growthStartDate: g.process.activityStartedAt,
      growthStartDateDisplay: g.process.activityStartedAtDisplay,
      growthEndDate: g.process.activityEndedAt,
      growthEndDateDisplay: g.process.activityEndedAtDisplay,
      isBeCluving,
    },
    period: {
      successWeeks: g.period.a,
      // 원천 없음 — 정책 정의 후 연결 필요. 임의 매핑 금지.
      successWeeksPending: null,
      failWeeks: g.period.b,
      personalRestWeeks: g.period.c,
      // 원천 없음 — 정책 정의 후 연결 필요. 임의 매핑 금지.
      personalRestWeeksPending: null,
      officialRestWeeks: g.period.d,
      growableWeeks: g.period.e,
      physicalWeeks: g.period.h,
      personalRestSeasons: g.period.f,
      successSeasons: g.period.g,
    },
    points: {
      totalStars: g.point.points,
      totalShields: g.point.netAdvantages,
      totalLightning: g.point.penalty,
      starsLabel: g.point.pointsLabel,
      shieldsLabel: g.point.advantagesLabel,
      lightningLabel: g.point.penaltyLabel,
    },
  };
}
