// Browser-safe contracts for public Cluster4 weekly card APIs.
// Keep this file free of server-only imports.

import type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";

export type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";

export type Cluster4LinePartType =
  | "information"
  | "experience"
  | "competency"
  | "career";

export type Cluster4LineStatus = "void" | "pending" | "success" | "fail";

// 강화 상태(enhancementStatus): "1차 라인 제출 대상자였는가(lineTargetId 존재)" 와
// "마감 여부" 중심으로 산정한다. 2차(라인 칸) submission 존재 여부로 success/fail 을
// 판단하지 않는다 — 마감(수 22:00 KST) 후 타깃이 있으면 미기입이라도 success 이며,
// submission(기입) 여부는 submissionStatus 로 분리해 노출한다.
export type Cluster4EnhancementStatus =
  | "success"
  | "fail"
  | "pending"
  | "not_applicable";

// 2차(라인 칸) submission 존재 여부. enhancementStatus 와 완전히 독립.
export type Cluster4SubmissionStatus =
  | "submitted"
  | "not_submitted"
  | "not_required";

// enhancementStatus 산정 근거.
export type Cluster4EnhancementReason =
  // 타깃 있음 + 마감 지남 → success (submission 유무 무관)
  | "target_exists_after_deadline"
  // 타깃 있음 + 마감 전 → pending
  | "target_exists_before_deadline"
  // 타깃 없음 + 제출했어야 하는 대상 → fail (명시적 기대 신호가 있을 때만)
  | "target_missing_required"
  // 타깃 없음 + 제출 불필요 + career → not_applicable
  | "target_missing_not_required_career"
  // 타깃 없음 + 제출 불필요 + 비career → not_applicable
  | "target_missing_not_required_non_career";

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
  // URL + label 구조. output_links jsonb 우선, 없으면 outputLink2~5 fallback.
  outputLinks: Cluster4OutputLink[];
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
  // 실무 정보(information) 라인에서 운영자가 라인 개설/관리 시 입력한 서브 타이틀·그로스 포인트.
  // cluster4_lines.info_subtitle / info_growth_point. 크루원 제출 submission.subtitle 과 별개 축.
  // info 외 part 또는 미입력 시 null. (append-only)
  infoSubtitle: string | null;
  infoGrowthPoint: string | null;
  outputLink1: string | null;
  // URL + label 구조. output_links jsonb 우선, 없으면 outputLink1 fallback.
  outputLinks: Cluster4OutputLink[];
  // cluster4_lines.output_images (운영자가 라인 개설 시 첨부한 이미지 URL 목록).
  // 없으면 []. (append-only — 기존 필드 변경 없음)
  outputImages: string[];
  // outputImages 와 index 정렬 일치하는 이미지 캡션. 캡션 없으면 null.
  // 프론트 <span class="caption-text"> 에 outputImageCaptions[i] 를 채운다 (null → 빈 문자열).
  // (append-only — outputImages 는 그대로 유지)
  outputImageCaptions: (string | null)[];

  // 운영자가 라인 개설/관리에서 입력한 outputLinks 중 URL 이 있는 항목 수.
  // 사용자 제출 링크는 절대 포함하지 않는다 (admin source: cluster4_lines.output_links).
  // 프론트는 outputLinks.length 로 관리자 슬롯 수를 추론하지 말고 이 값만 사용해야 한다:
  //   index <  adminOutputLinkCount → 관리자 링크 슬롯
  //   index >= adminOutputLinkCount → 사용자 링크 슬롯
  adminOutputLinkCount: number;
  // 운영자가 라인 개설/관리에서 첨부한 outputImages 수.
  // 사용자 제출 이미지는 절대 포함하지 않는다 (admin source: cluster4_lines.output_images).
  //   index <  adminOutputImageCount → 관리자 이미지 슬롯
  //   index >= adminOutputImageCount → 사용자 이미지 슬롯
  adminOutputImageCount: number;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;

  // 프론트가 "(weekId, partType, subLineKey)" 단위로 line 을 식별해 수정 버튼을
  // 활성화/비활성화하기 위한 키. canEdit 은 이 키 단위 (line target 단위) 로 산정된다.
  // 같은 주차 같은 partType 이라도 sub-line 이 다르면 별도 row 로 노출된다.
  weekId: string | null;

  // 실무 정보 (information): activity_types.id == cluster4_lines.activity_type_id
  // activityTypeKey 는 activity_types 의 string PK (예: "community", "essay", "wisdom") 와 동일.
  activityTypeId: string | null;
  activityTypeKey: string | null;
  activityTypeName: string | null;

  // 실무 역량 (competency)
  competencyLineMasterId: string | null;

  // 실무 경험 (experience)
  experienceLineMasterId: string | null;

  // 실무 경력 (career)
  careerProjectId: string | null;

  // cluster4_lines.line_code — competency/experience/career 공통 식별 코드.
  // career part 의 경우 career_projects.line_code 와 동일 (= projectCode).
  lineCode: string | null;
  projectCode: string | null;
};

// 포털 사용자 수정 가능 여부 사유. evaluateCluster4HubEdit 결과를 그대로 노출한다.
// ok_override = cluster4_line_targets 가 마감됐지만 user_edit_windows.cluster4.work_*
// override 가 활성화되어 운영자가 임시 편집권을 부여한 상태.
export type Cluster4LineEditReason =
  | "ok"
  | "ok_override"
  | "target_missing"
  | "not_owner"
  | "line_inactive"
  | "window_not_open"
  | "window_closed"
  | "unsupported_target_mode";

export type Cluster4LineDetailDto = Cluster4VisibleLineDto & {
  // 강화 상태 — 서버에서 계산해 그대로 노출한다. 프론트/어드민은 재계산하지 말 것.
  // status(void/pending/success/fail)는 2차 submission 중심의 기존 필드이고,
  // enhancementStatus 는 "라인 대상자였는가 + 마감" 중심의 별도 축이다 (혼동 금지).
  enhancementStatus: Cluster4EnhancementStatus;
  submissionStatus: Cluster4SubmissionStatus;
  enhancementReason: Cluster4EnhancementReason;
  submission: Cluster4LineSubmissionDto | null;
  // 라인별 이행 / 가용 / 비율. 가용 라인이 0(휴식 주차 등)이면 모두 null.
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  // 포털 수정 버튼 활성화/비활성화 조건. 프론트가 별도 재계산하지 않도록 서버에서 결정.
  // submission API (POST/PATCH /api/cluster4/lines/[lineTargetId]/submission) 의
  // 허용 조건과 동일한 정책으로 산정되므로 canEdit=true 면 실제 저장도 가능하다.
  canEdit: boolean;
  editReason: Cluster4LineEditReason;
};

export type Cluster4WeeklyPointsDto = {
  star: number | null;       // user_weekly_points.points
  shield: number | null;     // user_weekly_points.advantages
  lightning: number | null;  // user_weekly_points.penalty
};

// status-badge 아이콘 키 — Cluster4UserWeekStatus 와 1:1 동일.
// statusTone(semantic) 은 색상 톤 결정용이라 아이콘 매핑에는 사용하지 못한다(neutral/info/success/warning/danger 는
// running 과 tallying, personal_rest 와 official_rest 를 구분하지 못함). 그래서 별도 icon key 를 둔다.
export type Cluster4StatusIconKey = Cluster4UserWeekStatus;

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

  // ── section1-header 단일 출처 보강 필드 (append-only) ──
  // status-badge 아이콘 결정. userWeekStatus 와 동일 enum 이지만 "아이콘용" 이라는 의도를 명시.
  statusIconKey: Cluster4StatusIconKey;
  // 공개 정적 자산 경로. 프론트 매핑 테이블 없이 곧바로 <img src={statusIconUrl}/> 로 사용.
  statusIconUrl: string;

  // 누적 승인 주차 수 (status='success' 합 — 본 주차 포함, '진행/집계 중' +1 보정 미포함).
  // 진행/집계 중 표시는 displayWeekProgressLabel 로 별도 제공.
  // 출처: user_week_statuses.status='success' cumulative.
  accumulatedApprovedWeeks: number;
  // 졸업 목표 주차 수 (조직 상수: encre/phalanx=30, oranke=25).
  // 출처: lib/pointLabels.ts:GRADUATION_THRESHOLDS[organization].
  totalRequiredWeeks: number;
  // totalRequiredWeeks 의 alias (사양 호환용).
  baseWeekCount: number;
  // 프론트 계산 없이 곧바로 표시 가능한 주차 진행 라벨 (예: "+1 / 25 주차", "30 / 25 주차").
  // running/tallying 일 때만 highlight 부분이 "+1" 로 치환된다 — 이외에는 accumulatedApprovedWeeks.
  displayWeekProgressLabel: string;

  // 본 주차 시점의 사용자 기수 (user_team_parts.generation, joined_at<=weekStart<left_at). 없으면 null.
  generation: number | null;
  // 본 주차 시점의 운영진/팀장이 관리하는 팀 이름 (user_team_parts.managed_team_id → teams.name). 없으면 null.
  managedTeamName: string | null;
  // 본 주차가 사용자의 온보딩 주차인지 여부 (weekId === user_profiles.onboarding_week_id).
  isOnboarding: boolean;
};
