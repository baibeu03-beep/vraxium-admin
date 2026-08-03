import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadFinalizedWeeklyCardsReadOnly } from "@/lib/cluster4WeeklyCardsService";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import type { ProgressStatus, ReviewStatus } from "@/lib/cluster1ResumeTypes";
import { getCurrentActivityDateIso, isTransitionWeekStart } from "@/lib/seasonCalendar";
import { deriveEndStatus } from "@/lib/growthCore";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import {
  loadWeekOrgResultStates,
  resolveOrgResultScope,
  resolveWeekOrgResultState,
  type OrgResultScope,
} from "@/lib/weekOrgResultState";
import type { ScopeMode } from "@/lib/userScopeShared";

export type SeasonCardSummary = {
  approvedWeeks: number;
  failedWeeks: number;
  personalRestWeeks: number;
  officialRestWeeks: number;
  tallyingWeeks: number;
  totalWeeks: number;
  hasCards: boolean;
};

export type SeasonProgressInput = {
  growthStatus: string | null;
  seasonStatus: string | null;
  isCurrent: boolean;
  seasonEndDate: string;
  todayIso?: string;
  cards: SeasonCardSummary;
};

const STATUS = {
  ongoing: "진행 중" as ProgressStatus,
  complete: "정상 완료" as ProgressStatus,
  rest: "통합 휴식" as ProgressStatus,
  stopped: "활동 중단" as ProgressStatus,
  graduated: "정상 졸업" as ProgressStatus,
};

/** Weekly-card resultStatus를 시즌 단위로 접는 유일한 요약 함수. */
export function summarizeSeasonCards(
  cards: readonly Cluster4WeeklyCardDto[],
  seasonKey: string,
): SeasonCardSummary {
  const rows = cards.filter(
    (card) => card.seasonKey === seasonKey && !card.isTransition,
  );
  const summary: SeasonCardSummary = {
    approvedWeeks: 0,
    failedWeeks: 0,
    personalRestWeeks: 0,
    officialRestWeeks: 0,
    tallyingWeeks: 0,
    totalWeeks: rows.length,
    hasCards: rows.length > 0,
  };
  for (const card of rows) {
    switch (card.userWeekStatus) {
      case "success":
        summary.approvedWeeks++;
        break;
      case "fail":
        summary.failedWeeks++;
        break;
      case "personal_rest":
        summary.personalRestWeeks++;
        break;
      case "official_rest":
        summary.officialRestWeeks++;
        break;
      case "running":
      case "tallying":
        summary.tallyingWeeks++;
        break;
    }
  }
  return summary;
}

/** Growth Core의 수동 override/시즌 상태 우선순위를 시즌 레코드에 재사용한다. */
export function resolveSeasonProgressStatus(input: SeasonProgressInput): ProgressStatus {
  const today = input.todayIso ?? getCurrentActivityDateIso();
  const growth = (input.growthStatus ?? "").toLowerCase();
  if (growth === "graduated") return STATUS.graduated;
  // "활동 중단" 판정 = lib/growthCore.deriveEndStatus 단일 SoT 재사용(2026-08-03) — 종전엔
  // 여기서 ["suspended","withdrawn","expelled","deferred"] 를 따로 나열해 "paused"(성장 유보,
  // evaluationEligibility/getGrowthBadgeText 는 이미 활동 중단으로 취급)가 빠져 있었다. 그
  // 결과 growth_status='paused' 사용자는 이력서 카드엔 "성장 중단"이 뜨는데 시즌 행은
  // 날짜 범위만 보고 "진행 중"으로 표시되는 불일치가 있었다(실측: DB paused 4명 중 다수).
  if (input.seasonStatus === "stopped" || deriveEndStatus(growth) === "stopped" || ["withdrawn", "expelled", "deferred"].includes(growth)) {
    return STATUS.stopped;
  }
  if (input.seasonStatus === "rest") return STATUS.rest;
  if (input.isCurrent || today <= input.seasonEndDate) return STATUS.ongoing;
  if (input.cards.tallyingWeeks > 0) return STATUS.ongoing;
  if (input.cards.failedWeeks > 0 && input.cards.approvedWeeks === 0) return STATUS.stopped;
  // "통합 휴식"은 그 시즌의 공식 시즌 휴식 권위 원천(user_season_statuses.status='rest',
  // 위 seasonStatus==='rest' 분기) 하나로만 판정한다. 주차 카드 구성(개인 휴식·조직 방학주가
  // 얼마나 섞여 있는지, approvedWeeks 가 0인지)으로 "통합 휴식"을 추론하지 않는다 — 그렇게
  // 추론하면 미참여 시즌(조직 방학주만 카드로 남음)뿐 아니라 "그냥 주차 휴식 몇 번 쓴 정상
  // 활동 시즌"까지 시즌 전체 휴식으로 오표시된다. 개인 주차 휴식은 시즌 휴식이 아니다.
  return STATUS.complete;
}

export type SeasonReviewResult = {
  status: ReviewStatus;
  targetCount: number;
  completedCount: number;
  scope: OrgResultScope;
};

/** 시즌에 포함된 주차×조직의 실제 검수 상태를 집계한다. 날짜 경계는 사용하지 않는다. */
export async function resolveSeasonReviewStatusFromStore(input: {
  seasonKey: string;
  organization: OrganizationSlug | null;
  mode?: ScopeMode;
  todayIso?: string;
}): Promise<SeasonReviewResult> {
  const scope = resolveOrgResultScope(input.mode ?? "operating");
  const orgs = input.organization ? [input.organization] : ORGANIZATIONS;
  const today = input.todayIso ?? getCurrentActivityDateIso();
  const { data: weeks, error } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,result_published_at,result_reviewed_at")
    .eq("season_key", input.seasonKey)
    .lte("start_date", today)
    .order("start_date", { ascending: true });
  if (error) return { status: "검수 중", targetCount: 0, completedCount: 0, scope };
  const targets = (weeks ?? []).filter((week) => week.start_date && !isTransitionWeekStart(week.start_date));
  if (targets.length === 0) return { status: "검수 중", targetCount: 0, completedCount: 0, scope };

  let targetCount = 0;
  let completedCount = 0;
  for (const org of orgs) {
    const states = await loadWeekOrgResultStates(
      targets.map((week) => week.id as string),
      org,
      scope,
    );
    for (const week of targets) {
      targetCount++;
      const resolved = resolveWeekOrgResultState(
        states.get(week.id as string),
        String(week.start_date),
        week.result_reviewed_at != null,
      );
      if (resolved.status === "published") completedCount++;
    }
  }
  return {
    status: targetCount > 0 && completedCount === targetCount ? "확인 완료" : "검수 중",
    targetCount,
    completedCount,
    scope,
  };
}

export async function loadSeasonCardsReadOnly(userId: string) {
  return loadFinalizedWeeklyCardsReadOnly(userId);
}
