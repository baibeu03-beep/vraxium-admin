// Browser-safe contracts for public Cluster4 weekly card APIs.
// Keep this file free of server-only imports.

import type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";
import type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

export type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";
export type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

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
  | "target_missing_not_required_non_career"
  // career 전용 (P0): 타깃 있음 + 마감 후 + grade S/A/B/C → success
  | "career_grade_success"
  // career 전용 (P0): 타깃 있음 + 마감 후 + grade D(2점, 3점 이하) → fail
  | "career_grade_fail"
  // career 전용 (P0): 타깃 있음 + 마감 후 + 제출함 + grade 미입력 → pending (평가 대기)
  | "career_unevaluated_after_deadline"
  // career 전용 (P1): 타깃 있음(선발) + 마감 후 + 미제출 → fail
  | "career_not_submitted";

export type Cluster4LineTargetMode = "user" | "rule";

// 실무 경험 5슬롯 분류 (cluster4_experience_line_masters.experience_category).
// slot 과 1:1: derivation=1, analysis=2, evaluation=3, extension=4, management=5.
export type Cluster4ExperienceCategory =
  | "derivation"
  | "analysis"
  | "evaluation"
  | "extension"
  | "management";

export type Cluster4StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

// 실무 경험 필수 슬롯(도출/분석/평가) 기준 주차 성장 판정 (2026-05-30).
// 백엔드 SoT — 프론트는 재계산 없이 이 값을 그대로 렌더한다.
export type Cluster4ExperienceGrowthStatus =
  | "pass" // 성장 실패 아님
  | "fail" // 성장(실패)
  | "pending" // 진행·대기
  | "not_applicable"; // 규칙 미적용 (필수 슬롯 모두 미개설)

export type Cluster4ExperienceGrowthSlot = {
  slotOrder: number; // 1=도출 / 2=분석 / 3=평가
  category: Cluster4ExperienceCategory;
  enhancementStatus: Cluster4EnhancementStatus;
};

export type Cluster4ExperienceGrowth = {
  status: Cluster4ExperienceGrowthStatus;
  requiredSlots: Cluster4ExperienceGrowthSlot[];
  failedSlotOrders: number[];
  // verdict 가 userWeekStatus 에 fail 로 반영되었는지 (현재주/휴식 주차는 제외되어 false).
  appliedToWeekStatus: boolean;
};

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
  // 크루원 제출 그로스 포인트 (4개 허브 공통 제출 필드). 미제출/구버전 응답이면 null.
  growthPoint: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  // URL + label 구조. output_links jsonb 우선, 없으면 outputLink2~5 fallback.
  outputLinks: Cluster4OutputLink[];
  // 크루원 제출 이미지 (URL 목록 + index 정렬 일치 캡션). 없으면 [].
  outputImages: string[];
  outputImageCaptions: (string | null)[];
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
  // 실무 정보(information) 카드의 서브 타이틀·그로스 포인트 — 크루원 제출값(submission)에서 내려준다.
  // source: cluster4_line_submissions.subtitle / growth_point (= submission.subtitle / submission.growthPoint).
  //   (구: cluster4_lines.info_subtitle / info_growth_point 운영자 입력값 → 2026-05-30 deprecated)
  // info 외 part 또는 미제출 시 null. 소비처 호환을 위해 최상위 필드 유지(=submission.* 별칭).
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
  // 실무 경험 평점 — 운영자/평가값. source: cluster4_experience_line_evaluations.rating (0~10).
  //   (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑. experience 외 part 또는 미평가 시 null.
  //   사용자 제출값(submission)과 무관하며, draft 단계의 rating 은 open 이후 evaluations 로 복사된 값만 노출.
  //   프론트는 null 이면 "-" fallback.
  experienceRating: number | null;
  // 실무 경험 5슬롯 분류 — source: cluster4_experience_line_masters.experience_category / experience_slot_order.
  //   join: cluster4_lines.experience_line_master_id → masters.id. experience 외 part 또는 미분류 시 null.
  //   프론트는 experienceSlotOrder(1~5)로 고정 슬롯 배치, experienceCategory 가 null 이면 "-" fallback.
  //   category: derivation(도출,1)/analysis(분석,2)/evaluation(평가,3)/extension(확장,4)/management(관리,5).
  experienceCategory: Cluster4ExperienceCategory | null;
  experienceSlotOrder: number | null;

  // 실무 경력 (career)
  careerProjectId: string | null;
  // 실무 경력 평점 — source: cluster4_career_line_evaluations.grade / grade_points (P0).
  //   (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑. career 외 part 또는 미평가 시 null.
  //   사용자 제출값(submission)과 무관. grade: S/A/B/C/D, gradePoints: 10/8/6/4/2.
  careerGrade: CareerGrade | null;
  careerGradePoints: number | null;
  // 평가 결과 축 (마감 여부와 독립). career 외 part 는 null.
  //   unevaluated: grade 미입력 / success: S~C(4점 이상) / fail: D(2점, 3점 이하).
  //   강화 실패(D)는 enhancementStatus 에도 fail 로 반영된다(마감 후 기준).
  careerRatingStatus: CareerRatingStatus | null;

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

  // 실무 경험 필수 슬롯(도출/분석/평가) 기준 성장 판정 (append-only).
  // userWeekStatus 가 fail 인 사유가 이 verdict 인지 appliedToWeekStatus 로 확인 가능.
  experienceGrowth: Cluster4ExperienceGrowth;

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

  // 확정 누적 승인 주차 수 = 공표 완료(weeks.result_published_at)된 status='success' 합.
  // 현재주(진행 중)·미공표 주차(집계 중)는 미확정이므로 제외 → '진행/집계 중' 카드의 +1 base.
  // 표시용 +1 보정은 displayWeekProgressLabel 로 별도 제공 (이 값 자체는 보정 미포함).
  accumulatedApprovedWeeks: number;
  // 졸업 목표 주차 수 (조직 상수: encre/phalanx=30, oranke=25).
  // 출처: lib/pointLabels.ts:GRADUATION_THRESHOLDS[organization].
  totalRequiredWeeks: number;
  // totalRequiredWeeks 의 alias (사양 호환용).
  baseWeekCount: number;
  // 프론트 계산 없이 곧바로 표시 가능한 주차 진행 라벨 (예: "2 / 25 주차", "30 / 25 주차").
  // running/tallying 이면 accumulatedApprovedWeeks + 1 (표시용 프리뷰), 그 외에는 그대로.
  displayWeekProgressLabel: string;

  // 본 주차 시점의 사용자 기수 (user_team_parts.generation, joined_at<=weekStart<left_at). 없으면 null.
  generation: number | null;
  // 본 주차 시점의 운영진/팀장이 관리하는 팀 이름 (user_team_parts.managed_team_id → teams.name). 없으면 null.
  managedTeamName: string | null;
  // 본 주차가 사용자의 온보딩 주차인지 여부 (weekId === user_profiles.onboarding_week_id).
  isOnboarding: boolean;
};
