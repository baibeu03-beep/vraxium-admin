// ─────────────────────────────────────────────────────────────────────
// Cluster4 주간 성장 통합 타입.
//
// DB 저장값 4종 + 런타임 2종 = 총 6종 통합.
//   DB: success, fail, personal_rest, official_rest
//   런타임: running (진행 중), tallying (집계 중)
//
// 주차 결과 상태/라벨의 단일 출처는 shared/growth.contracts.ts 다.
// 아래는 기존 export 이름을 유지한 채 공통 contract 를 재참조한다(값 불변).
// ─────────────────────────────────────────────────────────────────────

import type {
  WeekDbStatusKey,
  WeekRuntimeStatusKey,
  WeekResultStatusKey,
} from "@/shared/growth.contracts";

// DB에 저장되는 주차 결과 상태 (user_week_statuses.status)
export type WeekDbStatus = WeekDbStatusKey;

// 런타임 전용 상태 (현재 주차 판별용)
export type WeekRuntimeStatus = WeekRuntimeStatusKey;

// 통합 6종 상태
export type WeekResultStatus = WeekResultStatusKey;

// 현재 주차 진행 상태 (기존 호환)
export type WeeklyGrowthStatus = "running" | "official_rest" | "transition";

export type RestReason =
  | "chuseok"
  | "lunar_new_year"
  | "exam_period"
  | "transition"
  | null;

export type EndStatus = "completed" | "stopped" | "in_progress";

// ─────────────────────────────────────────────────────────────────────
// 상태 라벨 매핑 (6종 통합)
// ─────────────────────────────────────────────────────────────────────

// 공통 contract 재노출 (값/이름 불변). 단일 출처: shared/growth.contracts.ts
export { WEEK_RESULT_LABELS as WEEK_STATUS_LABEL } from "@/shared/growth.contracts";

export const WEEK_STATUS_STYLE: Record<
  WeekResultStatus,
  { bg: string; text: string }
> = {
  running: { bg: "bg-sky-50", text: "text-sky-700" },
  tallying: { bg: "bg-violet-50", text: "text-violet-700" },
  success: { bg: "bg-emerald-50", text: "text-emerald-700" },
  fail: { bg: "bg-red-50", text: "text-red-700" },
  personal_rest: { bg: "bg-amber-50", text: "text-amber-700" },
  official_rest: { bg: "bg-blue-50", text: "text-blue-700" },
};

// ─────────────────────────────────────────────────────────────────────
// 주간 카드 DTO
// ─────────────────────────────────────────────────────────────────────

export type WeeklyCardLineDetail = {
  completed: number;
  available: number;
};

export type WeeklyCardLineBreakdown = {
  info: WeeklyCardLineDetail;
  ability: WeeklyCardLineDetail;
  experience: WeeklyCardLineDetail;
  career: WeeklyCardLineDetail;
};

// ─────────────────────────────────────────────────────────────────────
// 실무 경험 필수 슬롯(도출/분석/평가) 기준 주차 성장 판정 (2026-05-30)
// 백엔드 SoT — 프론트는 재계산 없이 이 값을 그대로 사용한다.
// ─────────────────────────────────────────────────────────────────────
export type ExperienceGrowthSlotDto = {
  slotOrder: number;
  category: "derivation" | "analysis" | "evaluation";
  enhancementStatus: "success" | "fail" | "pending" | "not_applicable";
};

export type ExperienceGrowthVerdictDto = {
  // pass = 성장 실패 아님 / fail = 성장(실패) / pending = 진행·대기 / not_applicable = 규칙 미적용
  status: "pass" | "fail" | "pending" | "not_applicable";
  requiredSlots: ExperienceGrowthSlotDto[];
  failedSlotOrders: number[];
  // verdict 가 이 주차 userWeekStatus 에 fail 로 실제 반영되었는지 (현재주/휴식 제외).
  appliedToWeekStatus: boolean;
};

export type WeeklyCardDto = {
  weekId: string | null;
  seasonYear: number;
  seasonName: string;
  seasonKey: string | null;
  weekNumber: number;
  startDate: string;
  endDate: string;
  dateRangeDisplay: string;
  resultStatus: WeekResultStatus;
  resultLabel: string;
  // 전환 주차(시즌 정규 주수 +1). 공식 휴식이 아니며 성장률·요약 집계에서 제외된다.
  isTransition: boolean;
  accumulatedApprovedWeeks: number;
  targetWeeks: number;
  activityStatus: string;
  // Raw crew metadata (null when source row missing) — used by public DTO.
  // teamLabel/partLabel/activityStatus keep "-"/"일반" fallbacks for admin UI.
  teamLabel: string;
  partLabel: string;
  teamNameRaw: string | null;
  partNameRaw: string | null;
  roleLabelRaw: string | null;
  membershipStatusLabelRaw: string | null;
  organizationSlug: string | null;
  points: number;
  advantages: number;
  penalty: number;
  // Raw nullable values: null when the source row is absent for this week.
  pointsRaw: number | null;
  advantagesRaw: number | null;
  penaltyRaw: number | null;
  cumulativeAdvantages: number | null;
  weeklyReputationCount: number;
  weeklyReputationCountRaw: number | null;
  totalFmScore: number;
  totalFmScoreRaw: number | null;
  linkedCrewCount: number;
  linkedCrewCountRaw: number | null;
  weekImagePath: string;
  weeklyGrowth: {
    completedLines: number;
    availableLines: number;
    rate: number;
  };
  lineBreakdown: WeeklyCardLineBreakdown;
  // 실무 경험 필수 슬롯(도출/분석/평가) 기준 성장 판정.
  experienceGrowth: ExperienceGrowthVerdictDto;
};

// ─────────────────────────────────────────────────────────────────────
// 기존 DTO (유지 — 현재 주차 요약 + 성장 요약)
// ─────────────────────────────────────────────────────────────────────

export type CurrentWeekInfo = {
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  status: WeeklyGrowthStatus;
  restReason: RestReason;
  nextSeasonName: string | null;
};

export type GrowthSummary = {
  startWeekDisplay: string;
  availableWeeks: number;
  approvedWeeks: number;
  failedWeeks: number;
  restWeeks: number;
  restSeasonCount: number;
  endWeekDisplay: string;
  endStatus: EndStatus;
};

export type SeasonGrowthRate = {
  seasonKey: string;
  seasonLabel: string;
  totalCompleted: number;
  totalAvailable: number;
  rate: number;
};

export type WeeklyGrowthDto = {
  currentWeekInfo: CurrentWeekInfo;
  growthSummary: GrowthSummary;
  weeklyCards: WeeklyCardDto[];
  seasonGrowthRates: SeasonGrowthRate[];
};

// ─────────────────────────────────────────────────────────────────────
// 필터 옵션 (UI 드롭다운용)
// ─────────────────────────────────────────────────────────────────────

export const RESULT_OPTIONS = [
  { value: "all", label: "전체" },
  { value: "success", label: "성장(성공)" },
  { value: "fail", label: "성장(실패)" },
  { value: "personal_rest", label: "휴식(개인)" },
  { value: "official_rest", label: "휴식(공식)" },
] as const;

// ─────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────

const REST_REASON_LABEL: Record<string, string> = {
  chuseok: "추석",
  lunar_new_year: "구정",
  exam_period: "시험 기간",
  transition: "전환 준비",
};

export function formatRestReasonLabel(reason: RestReason): string {
  if (!reason) return "공식 휴식";
  return REST_REASON_LABEL[reason] ?? "공식 휴식";
}

export function formatDateRange(start: string, end: string): string {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const dow = days[d.getDay()];
    return `${y}. ${m}. ${day} (${dow})`;
  };
  return `${fmt(s)} ~ ${fmt(e)}`;
}
