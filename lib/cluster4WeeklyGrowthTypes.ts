// ─────────────────────────────────────────────────────────────────────
// Cluster4 주간 성장 통합 타입.
//
// DB 저장값 4종 + 런타임 2종 = 총 6종 통합.
//   DB: success, fail, personal_rest, official_rest
//   런타임: running (진행 중), tallying (집계 중)
// ─────────────────────────────────────────────────────────────────────

// DB에 저장되는 주차 결과 상태 (user_week_statuses.status)
export type WeekDbStatus = "success" | "fail" | "personal_rest" | "official_rest";

// 런타임 전용 상태 (현재 주차 판별용)
export type WeekRuntimeStatus = "running" | "tallying";

// 통합 6종 상태
export type WeekResultStatus = WeekDbStatus | WeekRuntimeStatus;

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

export const WEEK_STATUS_LABEL: Record<WeekResultStatus, string> = {
  running: "성장(진행 중)",
  tallying: "성장(집계 중)",
  success: "성장(성공)",
  fail: "성장(실패)",
  personal_rest: "휴식(개인)",
  official_rest: "휴식(공식)",
};

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
  accumulatedApprovedWeeks: number;
  targetWeeks: number;
  activityStatus: string;
  teamLabel: string;
  partLabel: string;
  points: number;
  advantages: number;
  penalty: number;
  weeklyReputationCount: number;
  totalFmScore: number;
  linkedCrewCount: number;
  weekImagePath: string;
  weeklyGrowth: {
    completedLines: number;
    availableLines: number;
    rate: number;
  };
  lineBreakdown: WeeklyCardLineBreakdown;
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
