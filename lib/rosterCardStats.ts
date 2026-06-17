import { foldGrowthMetrics } from "@/lib/growthCore";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// roster slim 지표 파생 — /admin/members 크루 목록 전용 slim 캐시의 단일 산식.
//
// weekly-cards snapshot 카드(fat jsonb)에서 roster 가 필요한 스칼라만 뽑는다. 이 함수는
// cluster3GrowthData.getGrowthRosterBatch(buildIndicators a/e/h + 활동완료율 numerator/
// denominator)와 1:1 동일 산식이며, 고객 화면과 같은 SoT(snapshot 카드)에서 파생된다.
//   - successWeeks(a)/growableWeeks(e=a+b+c): foldGrowthMetrics(전환 제외, isTransitionWeekStart)
//   - elapsedWeeks(h): 전환 제외 + endDate < todayIso (onboarding 판정 전용, h≤1)
//   - activity*: 전환 제외(card.isTransition DTO 필드) numerator/denominator 합
//       (cluster1ResumeData.computeActivityCompletion 정의와 동일)
// 카드 status 가 비정상이면 null → 호출부가 fat 경로(실시간)로 폴백한다(snapshotCardsToLite 와 동일 게이트).
// ─────────────────────────────────────────────────────────────────────

export type RosterCardStats = {
  successWeeks: number; // a
  growableWeeks: number; // e = a+b+c
  elapsedWeeks: number; // h (todayIso 기준)
  activityAvailable: number;
  activityCompleted: number;
};

const WEEK_RESULT_STATUS_SET = new Set<string>([
  "running",
  "tallying",
  "success",
  "fail",
  "personal_rest",
  "official_rest",
]);

export function deriveRosterCardStats(
  cards: Cluster4WeeklyCardDto[],
  todayIso: string,
): RosterCardStats | null {
  // 성장지표용 lite (snapshotCardsToLite 와 동일 검증/변환).
  const lite: { status: string; isTransition: boolean; endDate: string }[] = [];
  for (const c of cards) {
    if (typeof c.startDate !== "string" || typeof c.endDate !== "string") return null;
    if (!WEEK_RESULT_STATUS_SET.has(c.userWeekStatus)) return null;
    lite.push({
      status: c.userWeekStatus,
      isTransition: isTransitionWeekStart(c.startDate),
      endDate: c.endDate,
    });
  }

  const { approvedWeeks: a, failedWeeks: b, restWeeks: c } = foldGrowthMetrics({
    weeks: lite.map((l) => ({ status: l.status, isTransition: l.isTransition })),
    restSeasonCount: 0,
  });
  const elapsedWeeks = lite.filter((l) => !l.isTransition && l.endDate < todayIso).length;

  // 활동 완료율 — DTO isTransition 필드 기준(computeActivityCompletion 과 동일 축).
  let activityAvailable = 0;
  let activityCompleted = 0;
  for (const card of cards) {
    if (card.isTransition) continue;
    activityAvailable += card.growthDenominator;
    activityCompleted += card.growthNumerator;
  }

  return {
    successWeeks: a,
    growableWeeks: a + b + c,
    elapsedWeeks,
    activityAvailable,
    activityCompleted,
  };
}

// activity available/completed → 완료율(%) 정수. available 0 → 0 (computeActivityCompletion 동일).
export function rosterActivityRate(available: number, completed: number): number {
  return available > 0 ? Math.round((completed / available) * 100) : 0;
}
