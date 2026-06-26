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

// 허브 강화율 집계 객체 (count=강화 성공 분자 B, total=가용 라인 분모 A, rate=round(B/A*100)).
//   "총 total개 중 count개 강화" 의미. 프론트 weekly-cards 소비처(Detail Log·카드 본문)의 단일 출처.
export type Cluster4RateDto = {
  rate: number;
  count: number;
  total: number;
};

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
  | "career_not_submitted"
  // experience 전용: 타깃 있음 + 마감 후 + 평점 3점 이하(rating <= 3) → fail
  | "experience_rating_fail"
  // competency 전용 (2026-06-04 v14): 선택 과제 미수행(라인 0개 포함) → 해당 없음이 아니라 강화 대기.
  // 역량은 1인·1주차 단일 칸 정규화 — not_applicable 불가.
  //   ⚠ v14.1 보정: "강화 대기"는 미확정(running/tallying) 주차에서만. 확정(공표) 주차의
  //   미수행은 competency_optional_unfulfilled_confirmed(강화 실패)로 내려간다.
  | "competency_optional_pending"
  // competency 전용 (2026-06-04 v14.1): 확정(result_published_at NOT NULL) 주차 + 선택 과제
  // 미수행(라인 0개) → 더 이상 수행 불가이므로 강화 실패(보이드 표시). den 수식(A=1·B=0) 불변.
  | "competency_optional_unfulfilled_confirmed";

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
  // 주차 인정 check 게이트 (2026-06-05 레거시 통합 라인 정책 — append-only).
  //   레거시 주차 + 강화 성공(평점 ≥4/미평가)일 때만 평가. passed=false && enforced=true 면
  //   주차 실패이지만 requiredSlots 의 enhancementStatus(강화)는 success 유지 — 강화/주차
  //   성공 분리 표시 근거. enforced=false = check 데이터 미이관 사용자 보존(강등 없음).
  checkGate?: {
    required: number; // 적용 기준값 (weeks.check_threshold ?? 30)
    earned: number; // 본인 point.check
    passed: boolean;
    enforced: boolean;
  } | null;
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
  // 라인명 — source: 마스터 테이블 line_name (experience/competency masters, career_projects).
  //   mainTitle 과 별개 축이다. 절대 서로 fallback 으로 섞지 않는다:
  //     lineName  ← master.line_name 만 (없으면 null)
  //     mainTitle ← cluster4_lines.main_title 만 (없으면 null)
  //   information part 는 마스터 line_name 이 없으므로 항상 null (라벨은 activityTypeName 사용).
  //   프론트는 라인명 슬롯(상단 문구·카드 배지)에 lineName 을, Main Title 입력칸에 mainTitle 을 매핑한다.
  lineName: string | null;
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
  //   ⚠ 내부 매칭/조회 전용. 개설 경로에 따라 날짜형(EXBS-EN241021)·센티넬(IF..-OPEN<ts>)
  //   같은 내부 코드가 들어갈 수 있어 고객 화면에 직접 노출하면 안 된다 — 표시는 displayLineCode 사용.
  lineCode: string | null;
  // 고객 표시용 공식 라인 코드 — /admin/lines/info(line_registrations.line_code) 우선, 미연결
  //   시 허브 마스터 line_code 폴백(둘 다 공식형). information 은 브리지가 없어 항상 null.
  //   미상이면 null — 프론트는 이 값이 없으면 코드를 숨기고 절대 lineCode 로 fallback 하지 않는다.
  displayLineCode: string | null;
  projectCode: string | null;

  // 실무 경력(career) sponsor-card 메타 — source: career_projects (careerProjectId 로 조회).
  //   companyName 의 SoT 는 career_projects.company_name (supervisor_company 아님).
  //   supervisorPhotoUrl 의 source 는 career_projects.supervisor_profile_img.
  //   career part 에만 값이 들어가고 그 외 part 는 전부 null. (append-only)
  companyName: string | null;
  companyLogoUrl: string | null;
  supervisorName: string | null;
  supervisorDepartment: string | null;
  supervisorPosition: string | null;
  supervisorPhotoUrl: string | null;
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

// 포인트 표시 정책(2026-06-04 통일): 고객 노출 값은 표시 최종값.
//   별 = check · 방패 = net(advantages−penalty) · 번개 = −penalty (음수 표기).
//   raw advantage(user_weekly_points.advantages)는 내부 집계 전용 — 고객 DTO 미노출.
export type Cluster4WeeklyPointsDto = {
  star: number | null;       // user_weekly_points.points
  shield: number | null;     // net = advantages − penalty (per-week)
  lightning: number | null;  // −penalty (음수 표기, per-week)
};

// status-badge 아이콘 키 — Cluster4UserWeekStatus 와 1:1 동일.
// statusTone(semantic) 은 색상 톤 결정용이라 아이콘 매핑에는 사용하지 못한다(neutral/info/success/warning/danger 는
// running 과 tallying, personal_rest 와 official_rest 를 구분하지 못함). 그래서 별도 icon key 를 둔다.
export type Cluster4StatusIconKey = Cluster4UserWeekStatus;

// ── 위클리 평판 / 연계 동료 인적사항 + 입력값 (append-only, 2026-06-02) ──
// 평판/동료 카드(미리보기·모달)의 프로필 영역에 표시할 대상자 인적사항 단일 출처.
//   - name        = user_profiles.display_name
//   - gender      = user_profiles.gender (원본 값 그대로, 매핑 없음)
//   - age         = user_profiles.birth_date 로부터 파생(만 나이). 없으면 null.
//   - school      = user_educations(대표 학력).school_name → user_profiles.school_name 폴백
//   - department  = user_educations(대표 학력).major_name_1 → user_profiles.department_name 폴백
//                   (학력의 canonical source 는 user_educations. PMS 이관 사용자는 department_name
//                    이 NULL 이고 실제 학과는 user_educations 에만 있으므로 반드시 educations 우선.)
//   - team/part   = user_memberships(is_current 우선).team_name / part_name
//   - membershipLevel = user_memberships.membership_level (일반/심화 등급값).
//                       ⚠ membership_state("active"/"weekly_rest" 등 상태값) 아님 — badge-status 는
//                       등급(level)이어야 하며 status=active 를 멤버십 값처럼 쓰면 안 된다.
//                       값 없을 때 role 로의 fallback 은 프론트(resolvePersonalInfo)가 수행.
//   - role        = user_profiles.role (crew/part_leader/agent/team_leader …). badge-status 의
//                   membership_level 미보유 시 fallback source.
//   - profileImageUrl = user_profiles.profile_photo_url
//   - profileTagline  = user_profiles.profile_tagline 우선 → 없으면 profile_keyword → 없으면 vision.
//                       (한줄 소개 — 희망 기업/직무/진로 목표). 평판 keyword(평가 태그)와 다른 축.
//                       셋 다 없으면 null(프론트 "-" fallback).
export type Cluster4PersonProfileDto = {
  userId: string;
  name: string | null;
  gender: string | null;
  age: number | null;
  school: string | null;
  department: string | null;
  team: string | null;
  part: string | null;
  membershipLevel: string | null;
  role: string | null;
  profileImageUrl: string | null;
  profileTagline: string | null;
};

// 받은 주간 평판 1건 (target_user_id = 카드 주인). 미리보기/모달 표시용.
//   fromUserId = reviewer_id(작성자), toUserId = target_user_id(=카드 주인).
//   fromProfile = 작성자 인적사항, toProfile = 대상자(카드 주인) 인적사항.
export type Cluster4WeeklyReputationDto = {
  id: string;
  weekId: string;
  fromUserId: string;
  toUserId: string;
  rating: number;
  comment: string;            // = weekly_reputations.content
  keyword: string;            // = weekly_reputations.keyword (tag)
  createdAt: string | null;
  fromProfile: Cluster4PersonProfileDto | null;
  toProfile: Cluster4PersonProfileDto | null;
};

// 작성한 연계 동료 1건 (user_id = 카드 주인). 미리보기/모달 표시용.
//   fromUserId = user_id(작성자=카드 주인), colleagueUserId = colleague_id(지목된 동료).
//   colleagueProfile = 지목된 동료의 인적사항.
export type Cluster4WeeklyColleagueDto = {
  id: string;
  weekId: string;
  fromUserId: string;
  colleagueUserId: string;
  rank: number;
  message: string | null;     // = weekly_colleagues.message
  createdAt: string | null;
  colleagueProfile: Cluster4PersonProfileDto | null;
};

// 주차 평판 요약. receivedCount 는 0~receivedLimit 로 cap, fm 은 반영 대상(≤4)의 rating 합.
//   fameScore/fmScore(누적 포인트)와는 별개 축 — 절대 혼동 금지.
export type Cluster4ReputationSummaryDto = {
  receivedCount: number;      // 0~4 (방어적 cap)
  receivedLimit: number;      // 4
  fm: number;                 // 반영 대상 평판 rating 합계
};

// 연계 동료 요약. writtenCount 는 그 주차 작성 건수, writtenLimit=3.
export type Cluster4ColleagueSummaryDto = {
  writtenCount: number;       // 작성 건수
  writtenLimit: number;       // 3
};

export type Cluster4DetailLogMessageMetaDto = {
  previousWeekStatus: "success" | "fail" | "none" | "rest";
  currentWeekStatus: "success" | "fail";
  successStreakWeeks: number;
};

// ── Detail Log 액트 내역 (append-only, v30) ──
// 1차 범위 = "수행/적립된 액트 내역"만(미수행/미적립 예정 액트·미스 row 제외).
// SoT = process_point_awards(사용자·주차 적립 원장). 행이 곧 "이 크루가 받은 액트" 이므로
//   변동>부분 대상자 필터(recipients matched / manual_grant target)가 원장 단계에서 이미 적용됨.
// 액트 상세는 JOIN: regular→process_acts(+process_line_groups), irregular→process_irregular_acts.
// 포인트(A/B/C)는 원장 적립값(수동 override 포함 실제 부여값) 그대로 — 마스터 재읽기 아님.
export type Cluster4ActLogSource = "regular" | "irregular";
// 1차는 수행/적립된 내역만 포함하므로 항상 "checked". (miss/실패 row 는 후속 Phase.)
export type Cluster4ActLogResult = "checked";
export type Cluster4ActLogDto = {
  weekNumber: number;             // 부착된 카드의 시즌 주차 번호
  result: Cluster4ActLogResult;   // 1차: "checked" 고정
  actName: string;
  occurredAt: string | null;      // 실제 발생/검수 시점 (irregular=scheduled_check_at??created_at, regular=completed_at??requested_at)
  requestedAt: string | null;     // 체크 신청 시점 (regular=process_check_statuses.requested_at, irregular=null)
  hub: string | null;             // regular=process_acts.hub, irregular=null(허브 비귀속)
  lineGroupName: string | null;   // regular=process_line_groups.name, irregular=null
  durationMinutes: number;        // 소요 시간(분). 없으면 0.
  pointA: number;                 // = process_point_awards.point_check
  pointB: number;                 // = process_point_awards.point_advantage
  pointC: number;                 // = process_point_awards.point_penalty
  source: Cluster4ActLogSource;
  // regular: process_acts.act_type ("required"|"selection"|레거시 "optional"|"basic")
  // irregular: process_irregular_acts.crew_reaction ("all"|"partial")
  kind: string;
};

export type Cluster4WeeklyCardDto = {
  weekId: string | null;
  weekNumber: number;
  weekLabel: string;
  weekTitle: string;
  displayTitle: string;
  startDate: string;
  endDate: string;
  // season_key (예: "2026-spring"). 시즌 단위 집계(area-6-circles 등)의 그룹 키.
  //   source: weeks.season_key. 합성/미상 주차는 null. (append-only, v10)
  seasonKey: string | null;
  // 전환 주차(시즌 정규 주수 +1) 여부. 성장률·주차 집계에서 제외 대상. (append-only, v10)
  isTransition: boolean;
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

  // ── 위클리 평판 / 연계 동료 상세 (append-only, 2026-06-02) ──
  // 미리보기/모달에서 인적사항·입력값을 렌더하기 위한 row 배열 + 요약.
  //   reputationSummary.fm 은 "받은 평판 rating 합계" (fameScore/fmScore=누적포인트 와 무관·별개).
  //   weeklyReputations 는 받은 평판(최대 4건, 방어적 cap). weeklyColleagues 는 작성한 동료.
  reputationSummary: Cluster4ReputationSummaryDto;
  colleagueSummary: Cluster4ColleagueSummaryDto;
  weeklyReputations: Cluster4WeeklyReputationDto[];
  weeklyColleagues: Cluster4WeeklyColleagueDto[];

  // 주차 성장률
  weeklyGrowthRate: number;
  growthNumerator: number;
  growthDenominator: number;

  // 실무 경험 허브 강화율 — breakdownFromLines(lines[]) 의 experience 칸 단일 출처.
  //   count = 강화 성공 칸 수(B), total = 가용 라인 칸 수(A=denominator), rate = round(B/A*100).
  //   레거시(2026 여름 W1 이전) 주차는 [통합] 주차 활동 내역(임시 통합 라인)이 experience 라인으로
  //   렌더되므로 total 에 그대로 포함된다 — "봄 시즌까지 통합 임시 라인을 오픈 라인으로 인정" 정책.
  //   휴식 주차는 {rate:0,count:0,total:0}. 프론트 Detail Log/카드 본문이 이 값을 그대로 소비한다.
  experienceRate: Cluster4RateDto;

  // 실무 경험 필수 슬롯(도출/분석/평가) 기준 성장 판정 (append-only).
  // userWeekStatus 가 fail 인 사유가 이 verdict 인지 appliedToWeekStatus 로 확인 가능.
  experienceGrowth: Cluster4ExperienceGrowth;

  imageUrl: string | null;
  thumbnailUrl: string | null;
  cardMessage: string | null;
  titleText: string;
  lines: Cluster4LineDetailDto[];
  detailLogMessageMeta?: Cluster4DetailLogMessageMetaDto;
  // ── Detail Log 액트 내역 (append-only, v30) ──
  // 그 주차에 이 크루가 수행/적립한 프로세스 액트 목록. 없으면 []. SoT=process_point_awards.
  // 프론트는 이 값을 "수행 내역"으로 렌더만 하고 별도 API 호출/임의 계산 금지(snapshot-only).
  actLogs?: Cluster4ActLogDto[];

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

// ─────────────────────────────────────────────────────────────────────
// cluster-4-1 진입 화면 area-6-circles (원형 지표 3개). 현재 시즌 단위 집계.
//   단일 출처(SoT) = weekly-cards 스냅샷 cards 배열 (snapshot-only).
//   파생 규칙(lib/cluster4SeasonCircles.computeAreaSixCircles)은 순수 함수이며
//   동일 cards 입력에 항상 동일 결과 → demoUserId/일반 모드 동일 DTO, 실시간 계산값과
//   스냅샷 응답값이 갈라지지 않는다. 모든 분모/분자는 현재 시즌·전환주차 제외 기준.
//
//   1) 주차 활용도 weekUsage   = round(approvedWeeks / availableWeeks * 100)
//   2) 일정 신뢰도 scheduleReliability = round(reliableWeeks(=approved+rest) / availableWeeks * 100)
//   3) 시즌 성장률 seasonGrowth = round(completedLines / availableLines * 100)
//
//   주차 정의(admin Cluster4 SoT, 공식 휴식 제외):
//     approvedWeeks(a) = userWeekStatus==success   (published + verdict 반영된 카드 상태)
//     restWeeks(c)     = userWeekStatus==personal_rest
//     availableWeeks(e)= success + fail + personal_rest
//     reliableWeeks    = approvedWeeks + restWeeks (= a + c)
//   라인 정의: 현재 시즌·비전환 카드의 growthNumerator/growthDenominator 합
//     (org 필터·강화 정책은 카드 계산 시점에 이미 반영됨).
// ─────────────────────────────────────────────────────────────────────
export type Cluster4AreaSixCirclesDto = {
  // 집계 대상 현재 시즌 키. 현재 시즌 카드가 없으면 null(전부 0).
  seasonKey: string | null;
  // 주차 활용도
  weekUsage: number; // %
  approvedWeeks: number; // a (분자)
  // 일정 신뢰도
  scheduleReliability: number; // %
  reliableWeeks: number; // a + c (분자)
  restWeeks: number; // c
  // 두 주차 지표 공통 분모
  availableWeeks: number; // e (분모)
  // 시즌 성장률
  seasonGrowth: number; // %
  completedLines: number; // 이행 라인 (분자)
  availableLines: number; // 전체 가용 라인 (분모)
};

// ─────────────────────────────────────────────────────────────────────
// cluster-4-1 진입 화면 area-7-progress (실무 4허브 강화율 4개). 현재 시즌 단위 누적.
//   단일 출처(SoT) = weekly-cards 스냅샷 cards 배열 (snapshot-only) — area-6-circles 와 동일.
//   파생 규칙(lib/cluster4SeasonCircles.computeSeasonAreaProgress)은 순수 함수이며
//   동일 cards 입력에 항상 동일 결과 → demoUserId/일반 모드 동일 DTO, 실시간 계산값과
//   스냅샷 응답값이 갈라지지 않는다.
//
//   허브(part) 단위 누적: 현재 시즌·비전환 카드의 각 part 라인 numerator/denominator 합.
//     earned = Σ part numerator, total = Σ part denominator, rate = round(earned/total*100).
//   분모/분자 정의는 cluster-4-card 주차 성장률/허브 강화율과 동일 source(카드 라인 breakdown):
//     · 같은 주차·같은 part 의 sub-line 들은 동일 part 집계값을 공유하므로 카드당 part 1회만 합산.
//     · available<=0(미개설)·휴식 주차 라인은 numerator/denominator=null 로 자연 제외.
//   key/label 매핑: information=실무 정보 / experience=실무 경험 / competency=실무 역량 / career=실무 경력.
// ─────────────────────────────────────────────────────────────────────
export type Cluster4SeasonAreaProgressKey =
  | "practical_info"
  | "practical_experience"
  | "practical_competency"
  | "practical_career";

export type Cluster4SeasonAreaProgressItem = {
  key: Cluster4SeasonAreaProgressKey;
  label: string; // "실무 정보" / "실무 경험" / "실무 역량" / "실무 경력"
  rate: number; // round(earned/total*100), total 0 → 0
  total: number; // 시즌 누적 가용 라인 (분모)
  earned: number; // 시즌 누적 이행 라인 (분자)
};

// area-7-progress 응답 — 항상 4개 항목(정보/경험/역량/경력) 고정 순서.
export type Cluster4SeasonAreaProgressDto = Cluster4SeasonAreaProgressItem[];
