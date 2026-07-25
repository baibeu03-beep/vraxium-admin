import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadFinalizedWeeklyCardsReadOnly } from "@/lib/cluster4WeeklyCardsService";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import type { ProgressStatus, ReviewStatus } from "@/lib/cluster1ResumeTypes";
import { getCurrentActivityDateIso, isTransitionWeekStart } from "@/lib/seasonCalendar";
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
  if (input.seasonStatus === "stopped" || ["suspended", "withdrawn", "expelled", "deferred"].includes(growth)) {
    return STATUS.stopped;
  }
  if (input.seasonStatus === "rest") return STATUS.rest;
  if (input.isCurrent || today <= input.seasonEndDate) return STATUS.ongoing;
  if (input.cards.tallyingWeeks > 0) return STATUS.ongoing;
  if (input.cards.failedWeeks > 0 && input.cards.approvedWeeks === 0) return STATUS.stopped;
  if (input.cards.personalRestWeeks + input.cards.officialRestWeeks > 0 && input.cards.approvedWeeks === 0) {
    return STATUS.rest;
  }
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
