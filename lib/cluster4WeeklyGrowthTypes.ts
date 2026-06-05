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
  // 주차 인정 check 게이트 (2026-06-05 레거시 통합 라인 정책 정정 — append-only).
  //   레거시 주차에서 강화 성공(평점 ≥4/미평가)일 때만 평가된다. passed=false &&
  //   enforced=true 면 status=fail(주차 실패)이지만 requiredSlots 의 enhancementStatus
  //   (강화)는 success 유지. enforced=false = 실사용자 check 미이관 보존(강등 없음).
  checkGate?: {
    required: number; // 적용 기준값 (weeks.check_threshold ?? 30)
    earned: number; // 본인 point.check (user_weekly_points.points)
    passed: boolean;
    enforced: boolean;
  } | null;
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

// ─────────────────────────────────────────────────────────────────────
// cluster-4-1 진입 화면 상단 시즌 요약 (area-1-title / area-4-stats).
//   화면 단위 단일 시즌 정보 + 그 시즌 누적 포인트. 카드별 값이 아니다.
//   source: seasonSummary = seasonCalendar(현재 시즌) / seasonPointSummary =
//   weeklyCards 중 현재 시즌·비전환 주차의 user_weekly_points 누적.
// ─────────────────────────────────────────────────────────────────────
export type SeasonStatus = "active" | "ended" | "upcoming";

export type SeasonSummary = {
  year: number; // 시즌 연도 (예: 2026 → 프론트 "26년도")
  seasonName: string; // 한글 시즌명 ("봄"/"여름"/"가을"/"겨울") — 프론트 "봄 시즌" 표기 시 +" 시즌"
  seasonCode: string; // 영문 코드 ("spring"/"summer"/"autumn"/"winter")
  displayTitle: string; // "26년도 봄 시즌" (year+seasonName 조합 완제품)
  dateRangeLabel: string; // "2026.03.02 - 2026.06.21" — 전환주차 제외 정규 시즌 범위
  status: SeasonStatus; // 진행중/종료/예정 (오늘 vs 정규 시즌 범위)
  statusLabel: string; // "진행중"/"종료"/"예정"
  startDate: string; // 시즌 1주차 월요일 (YYYY-MM-DD)
  endDate: string; // 시즌 정규 마지막 주 일요일 (전환주차 제외, YYYY-MM-DD)
};

// 포인트 표시 정책(2026-06-04 통일): 고객 노출 값은 표시 최종값.
//   방패 = net(Σadvantages−Σpenalty), 번개 = −Σpenalty (음수 표기). raw advantage 미노출.
export type SeasonPointSummary = {
  star: number; // sum(user_weekly_points.points) — 전환주차 제외
  shield: number; // net = sum(advantages) − sum(penalty) — 전환주차 제외
  lightning: number; // −sum(penalty) (음수 표기) — 전환주차 제외
};

// ─────────────────────────────────────────────────────────────────────
// cluster-4 진입 화면 area-8-season-status — 현재 시즌 동안의 팀/파트/상태 활동 이력.
//   "이 시즌에 어떤 팀/파트로, 어떤 상태(일반/심화/운영진)로 활동했는가" 를 발생 순서대로 보여준다.
//   source(이력):  user_team_parts(team_id/part_id/joined_at/left_at/managed_team_id) — 팀/파트 시간축,
//                  user_role_history(role/started_at/ended_at) — 역할(상태) 시간축.
//   라벨:          teams.name / parts.name.
//   상태 결정:     role(이력 우선) + user_memberships.membership_level(현재 등급) + user_profiles.role(fallback).
//   필터:          현재 시즌 범위(season.startDate ~ season.endDate, 전환주차 포함)와 겹치는 row 만.
//   정렬:          startedAt ASC (없으면 마지막). 연속 동일(team/part/status) 병합 후 최대 6개.
//   이력 row 가 없으면 현재 membership/profile 로 단일 항목 fallback(startedAt/endedAt=null).
//
// 표시 규칙(프론트 area-8-season-status):
//   A. 일반/심화 크루   → teamLabel=팀, partLabel=파트, statusLabel ∈ {일반, 심화(에이전트), 심화(파트장)}
//   B. 운영진(팀장)     → teamLabel="운영진(n기)", partLabel="클럽 단위", statusLabel="팀장(00 팀)"
//   C. 운영진(앰배서더) → teamLabel="운영진(n기)", partLabel="클럽 단위", statusLabel="앰배서더"
//   (기수 정보 미보유 — 운영진 teamLabel 은 일단 항상 "운영진(n기)".)
export type SeasonActivityStatus = {
  id: string; // 안정적 식별자 (user_team_parts.id 또는 fallback 합성 키)
  order: number; // 발생 순서 (1-base, startedAt ASC)
  teamLabel: string; // 팀명 / 운영진(n기). 없으면 "-".
  partLabel: string; // 파트명 / 클럽 단위. 없으면 "-".
  statusLabel: string; // 상태 (일반/심화(…)/팀장(…)/앰배서더). 없으면 "-".
  rawRole: string | null; // 판정에 쓰인 raw role (user_role_history 또는 user_profiles.role)
  rawMembershipLevel: string | null; // user_memberships.membership_level (일반/심화)
  startedAt: string | null; // 활동 시작 (user_team_parts.joined_at). fallback 시 null.
  endedAt: string | null; // 활동 종료 (user_team_parts.left_at). 진행 중/ fallback 시 null.
};

export type WeeklyGrowthDto = {
  currentWeekInfo: CurrentWeekInfo;
  growthSummary: GrowthSummary;
  weeklyCards: WeeklyCardDto[];
  seasonGrowthRates: SeasonGrowthRate[];
  // cluster-4-1 진입 화면 상단 시즌 요약. seasonSummary 의 시즌과 seasonPointSummary 의
  // 누적 범위는 항상 동일 시즌(현재 시즌)이며 전환주차를 제외한다.
  // 현재 시즌 판별 불가(달력 갭) 시 seasonSummary=null, seasonPointSummary=0.
  seasonSummary: SeasonSummary | null;
  seasonPointSummary: SeasonPointSummary;
  // area-8-season-status — 현재 시즌 팀/파트/상태 활동 이력(최대 6개, 발생순).
  // 현재 시즌 판별 불가 시 [].
  seasonActivityStatuses: SeasonActivityStatus[];
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
