// Browser-safe contracts for public Cluster4 weekly card APIs.
// Keep this file free of server-only imports.

export type Cluster4LinePartType =
  | "information"
  | "experience"
  | "competency"
  | "career";

export type Cluster4LineStatus = "void" | "pending" | "success" | "fail";

export type Cluster4LineTargetMode = "user" | "rule";

export type Cluster4StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export type Cluster4UserWeekStatus =
  | "running"
  | "tallying"
  | "success"
  | "fail"
  | "personal_rest"
  | "official_rest";

export type Cluster4LineSubmissionDto = {
  id: string;
  lineTargetId: string;
  subtitle: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  submittedAt: string;
  updatedAt: string;
};

export type Cluster4VisibleLineDto = {
  partType: Cluster4LinePartType;
  status: Cluster4LineStatus;
  statusLabel: string;
  lineId: string | null;
  lineTargetId: string | null;
  targetMode: Cluster4LineTargetMode | null;
  mainTitle: string | null;
  outputLink1: string | null;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

export type Cluster4LineDetailDto = Cluster4VisibleLineDto & {
  submission: Cluster4LineSubmissionDto | null;
  // 라인별 이행 / 가용 / 비율. 가용 라인이 0(휴식 주차 등)이면 모두 null.
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
};

export type Cluster4WeeklyPointsDto = {
  star: number | null;       // user_weekly_points.points
  shield: number | null;     // user_weekly_points.advantages
  lightning: number | null;  // user_weekly_points.penalty
};

export type Cluster4WeeklyCardDto = {
  weekId: string | null;
  weekNumber: number;
  weekLabel: string;
  weekTitle: string;
  displayTitle: string;
  startDate: string;
  endDate: string;
  userWeekStatus: Cluster4UserWeekStatus;
  statusLabel: string;
  statusTone: Cluster4StatusTone;
  isRestWeek: boolean;

  // 사용자 소속/역할 메타 (raw — 빈 값이면 null)
  teamName: string | null;
  partName: string | null;
  roleLabel: string | null;            // = membershipLevel
  membershipStatusLabel: string | null; // = membershipState

  // 주차 포인트 (조직 무관 키. 실제 라벨은 조직별 매핑 — encre: 별/방패/번개, oranke: 단감/인절미/어흥)
  points: Cluster4WeeklyPointsDto;

  // 누적
  cumulativeInjeolmi: number | null;   // sum(user_weekly_points.advantages) 누적 (oranke=인절미)
  fameScore: number | null;            // 누적 명성도(FM)
  fmScore: number | null;              // alias of fameScore

  // 평판 / 연계동료 (목표값은 hardcoded — admin UI 와 동일)
  reputationCount: number | null;
  reputationTotal: number;             // 4
  colleagueCount: number | null;
  colleagueTotal: number;              // 3

  // 주차 성장률
  weeklyGrowthRate: number;
  growthNumerator: number;
  growthDenominator: number;

  imageUrl: string | null;
  thumbnailUrl: string | null;
  cardMessage: string | null;
  titleText: string;
  lines: Cluster4LineDetailDto[];
};
