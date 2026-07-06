import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";
import {
  getCompetencyMetaByMasterIdsRegFirst,
  getExperienceMetaByMasterIdsRegFirst,
} from "@/lib/lineRegistrationLookup";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  getWeeklyGrowth,
  getWeeklyGrowthByUserId,
  computeSeasonGrowthRates,
} from "@/lib/cluster4WeeklyGrowthData";
import type {
  WeekResultStatus,
  WeeklyCardDto,
  WeeklyCardLineBreakdown,
  WeeklyCardLineDetail,
  WeeklyGrowthDto,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  CAREER_DISPLAY_CAP,
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  EXPERIENCE_ALWAYS_OPEN_SLOT_ORDERS,
  EXPERIENCE_MANAGEMENT_SLOT_ORDER,
  EXPERIENCE_SLOT_CATEGORY,
  fetchLegacyUnifiedMasterId,
  fetchManagementSlotOpen,
  roundGrowthRate,
} from "@/lib/lineAvailability";
import { normalizeOutputImages } from "@/lib/cluster4OutputImages";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import {
  CLUSTER4_HUB_EDIT_WINDOW_KEYS,
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  evaluateCluster4HubEdit,
  isEditWindowActive,
  type Cluster4EditWindowSnapshot,
  type Cluster4HubEditDecisionReason,
} from "@/lib/cluster4LinePermission";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import {
  computeCluster4Enhancement,
  EXPERIENCE_RATING_FAIL_THRESHOLD,
} from "@/lib/cluster4Enhancement";
import {
  type CareerGrade,
  careerRatingStatusFromGrade,
} from "@/lib/careerGrade";
import {
  isLineVisibleForUserOrg,
  parseLineCodeOrg,
  type LineOrgScope,
} from "@/lib/cluster4LineOrg";
import { resolveLineScopeFromValues } from "@/lib/lineScope";
import { fetchUserOrganizationSlug } from "@/lib/userOrg";
import {
  emptyWeeklyPeople,
  fetchWeeklyPeopleByWeek,
  type WeeklyPeople,
} from "@/lib/cluster4WeeklyPeopleData";
import type {
  Cluster4ExperienceCategory,
  Cluster4LineDetailDto,
  Cluster4LineEditReason,
  Cluster4LinePartType,
  Cluster4LineSubmissionDto,
  Cluster4LineTargetMode,
  Cluster4StatusIconKey,
  Cluster4StatusTone,
  Cluster4UserWeekStatus,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";

// admin/Cluster4Editor.tsx에서 사용된 하드코드 목표값 (주차 평판 4, 연계 동료 3)
const REPUTATION_TARGET = 4;
const COLLEAGUE_TARGET = 3;

type DbLinePartType = "info" | "experience" | "competency" | "career";

type TargetWithLineRow = {
  id: string;
  line_id: string;
  week_id: string;
  target_mode: Cluster4LineTargetMode;
  target_user_id: string | null;
  target_rule: Record<string, unknown> | null;
  cluster4_lines: {
    id: string;
    part_type: DbLinePartType;
    main_title: string;
    output_link_1: string | null;
    output_links: unknown;
    // 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → unknown 으로 받아 정규화.
    output_images: unknown;
    submission_opens_at: string;
    submission_closes_at: string;
    is_active: boolean;
    // sub-line 식별자 (cluster4_lines bridge / phase1 / competency masters 컬럼).
    // canEdit 매칭이 part_type 단위가 아니라 sub-line 단위로 이루어지도록 노출.
    activity_type_id: string | null;
    line_code: string | null;
    team_id: string | null;
    competency_line_master_id: string | null;
    experience_line_master_id: string | null;
    career_project_id: string | null;
  } | null;
};

type ActivityTypeRow = {
  id: string;
  name: string;
};

// cluster4_experience_line_masters 의 5슬롯 분류 메타 (experience part 라인에만 적용).
type ExperienceMasterMeta = {
  category: Cluster4ExperienceCategory | null;
  slotOrder: number | null;
  // 라인명 (DTO.lineName source). main_title 과 별개 — 섞지 않는다.
  lineName: string | null;
  // 조직 노출 판정 SoT (org 필터용). 'encre'|'oranke'|'phalanx'|'common'|null.
  organizationSlug: string | null;
  // 고객 표시용 공식 라인 코드 (DTO.displayLineCode source). registration(line_registrations.line_code)
  // 우선·마스터 폴백. 개설 시 생성되는 내부 line_code(날짜형/센티넬)와 별개. 미상이면 null(숨김).
  displayLineCode: string | null;
};

// cluster4_competency_line_masters 메타 (competency part 라인에만 적용).
type CompetencyMasterMeta = {
  // 라인명 (DTO.lineName source).
  lineName: string | null;
  // 조직 노출 판정 SoT (org 필터용).
  organizationSlug: string | null;
  // 고객 표시용 공식 라인 코드 (DTO.displayLineCode source — experience 와 동일 의미).
  displayLineCode: string | null;
};

// cluster4_career_line_evaluations 의 평점 (career part 라인에만 적용).
type CareerGradeEval = {
  grade: CareerGrade;
  points: number;
};

// career_projects 의 sponsor-card 메타 (career part 라인에만 적용).
// careerProjectId → 회사/감독자 표시 값. companyName 의 SoT 는 career_projects.company_name.
type CareerProjectMeta = {
  companyName: string | null;
  companyLogoUrl: string | null;
  supervisorName: string | null;
  supervisorDepartment: string | null;
  supervisorPosition: string | null;
  supervisorPhotoUrl: string | null;
  // 라인명 (DTO.lineName source). career_projects.line_name. default_main_title 과 별개.
  lineName: string | null;
  // 조직 노출 판정 SoT (org 필터용).
  organizationSlug: string | null;
  // 고객 표시용 공식 라인 코드 (DTO.displayLineCode source) = career_projects.line_code.
  displayLineCode: string | null;
};

type SubmissionRow = {
  id: string;
  line_target_id: string;
  subtitle: string | null;
  growth_point: string | null;
  output_link_2: string | null;
  output_link_3: string | null;
  output_link_4: string | null;
  output_link_5: string | null;
  output_links: unknown;
  // 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → 정규화.
  output_images: unknown;
  submitted_at: string;
  updated_at: string;
};

type EditWindowDbRow = {
  resource_key: string;
  week_id: string | null;
  opened_at: string;
  expires_at: string;
};

// 한 part_type 의 override 묶음: 주차별 행 + 전역(week_id=NULL) 행.
// 판정은 (해당 카드 주차 행 OR 전역 행) 중 현재 active 한 것을 채택한다(additive OR).
type HubEditWindowEntry = {
  byWeek: Map<string, Cluster4EditWindowSnapshot>;
  global: Cluster4EditWindowSnapshot;
};

// 카드(part_type, weekId) 에 적용할 override 를 고른다.
//   - 주차별 행이 active 면 그것을, 아니면 전역 행이 active 면 그것을.
//   - 둘 다 비활성/부재면 null (override 없음 → 기본 라인 창만으로 canEdit 판정).
// evaluateCluster4HubEdit 는 받은 window 에 isEditWindowActive 를 다시 적용하므로
// active 한 행을 넘기면 ok_override, null 이면 라인 창 결과가 그대로 유지된다.
function resolveHubEditWindow(
  entry: HubEditWindowEntry | undefined,
  weekId: string,
  now: number,
): Cluster4EditWindowSnapshot {
  if (!entry) return null;
  const wk = entry.byWeek.get(weekId) ?? null;
  if (wk && isEditWindowActive(wk, now)) return wk;
  if (entry.global && isEditWindowActive(entry.global, now)) return entry.global;
  return null;
}

// Cluster4HubEditDecisionReason 은 cluster4LinePermission.ts 의 union(8개) 과 1:1 동일.
// Cluster4LineEditReason 은 같은 모양으로 contracts 에 재선언되어 있다 — 서버에서
// 계산한 reason 을 그대로 DTO 에 반환한다.
function decisionReasonToDto(
  reason: Cluster4HubEditDecisionReason,
): Cluster4LineEditReason {
  return reason;
}

const PUBLIC_PARTS: Cluster4LinePartType[] = [
  "information",
  "experience",
  "competency",
  "career",
];

const TARGET_WITH_LINE_SELECT = `
  id,
  line_id,
  week_id,
  target_mode,
  target_user_id,
  target_rule,
  cluster4_lines!inner(
    id,
    part_type,
    main_title,
    output_link_1,
    output_links,
    output_images,
    submission_opens_at,
    submission_closes_at,
    is_active,
    activity_type_id,
    line_code,
    team_id,
    competency_line_master_id,
    experience_line_master_id,
    career_project_id
  )
`;
// NOTE: is_qa_test 는 SELECT 에 넣지 않는다 — 필터(.eq("...is_qa_test", false))는 컬럼명으로 동작하며,
//   QA 기간(QA_HIDE_REAL_USERS=true)엔 필터 자체가 미적용이라 컬럼 부재(마이그 전)에도 조회가 깨지지 않는다.
//   운영(flag=false) 전환 시점엔 마이그레이션이 이미 적용돼 있어야 한다(migration 파일 주석 참조).

// cluster4_lines 단독 조회 컬럼 — TARGET_WITH_LINE_SELECT 의 cluster4_lines 본문과 동일 필드
// (+ week_id). 타깃 0건 라인을 "개설 신호"로 보강할 때 라인 객체 모양을 targetRows 와 일치시킨다.
const LINE_ROW_SELECT = `
  id,
  week_id,
  part_type,
  main_title,
  output_link_1,
  output_links,
  output_images,
  submission_opens_at,
  submission_closes_at,
  is_active,
  activity_type_id,
  line_code,
  team_id,
  competency_line_master_id,
  experience_line_master_id,
  career_project_id
`;

// openedByWeek 보강용 라인 행 = targetRows 의 cluster4_lines 객체 + 자신의 week_id.
type InfoLineRow = NonNullable<TargetWithLineRow["cluster4_lines"]> & {
  week_id: string | null;
};

export class Cluster4WeeklyCardsError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Cluster4WeeklyCardsError";
    this.status = status;
  }
}

function toPublicPart(partType: DbLinePartType): Cluster4LinePartType {
  return partType === "info" ? "information" : partType;
}

function emptyLine(
  partType: Cluster4LinePartType,
  weekId: string | null = null,
  expectedWhenMissing = false,
): Cluster4LineDetailDto {
  // 미개설 placeholder — 타깃/평가가 없으므로 experienceRating 은 항상 null.
  // partType 단위 "미개설" placeholder. lineTargetId 가 없으므로 canEdit=false /
  // editReason="target_missing" 으로 고정 (override 가 OPEN 이어도 동일 — target 없는
  // sub-line 에는 override 가 적용되면 안 된다).
  // 강화 상태(2026-06-02): 타깃 부재일 때 — 그 주차에 (해당 part) 라인이 개설됐으면 fail,
  //   미개설이면 not_applicable. expectedWhenMissing 이 그 신호이며, 호출부에서 line 행 존재
  //   (fetchWeeksWithAny{Info,Experience,Competency}Line) + 휴식주차 게이트로 계산해 전달한다.
  //   info/experience/competency 모두 동일 기준 — competency 의 "항상 fail" 강제는 폐기됐다.
  //   (career 는 미선발=타깃 없음=not_applicable 이므로 호출부에서 expectedWhenMissing=false.)
  //   fail 이어도 status='void'(보이드/미개설 표시)는 그대로 유지된다.
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: partType === "career",
    expectedWhenMissing,
  });
  return {
    partType,
    status: "void",
    statusLabel: "미개설",
    enhancementStatus: enhancement.enhancementStatus,
    submissionStatus: enhancement.submissionStatus,
    enhancementReason: enhancement.enhancementReason,
    lineId: null,
    lineTargetId: null,
    targetMode: null,
    lineName: null,
    mainTitle: null,
    infoSubtitle: null,
    infoGrowthPoint: null,
    outputLink1: null,
    outputLinks: [],
    outputImages: [],
    outputImageCaptions: [],
    adminOutputLinkCount: 0,
    adminOutputImageCount: 0,
    submissionOpensAt: null,
    submissionClosesAt: null,
    weekId,
    activityTypeId: null,
    activityTypeKey: null,
    activityTypeName: null,
    competencyLineMasterId: null,
    experienceLineMasterId: null,
    experienceRating: null,
    experienceCategory: null,
    experienceSlotOrder: null,
    careerProjectId: null,
    careerGrade: null,
    careerGradePoints: null,
    careerRatingStatus: null,
    lineCode: null,
    // 미개설 placeholder — 표시용 라인 코드 없음(고객 화면 숨김).
    displayLineCode: null,
    projectCode: null,
    // sponsor-card 메타 — 미개설 placeholder 이므로 항상 null.
    companyName: null,
    companyLogoUrl: null,
    supervisorName: null,
    supervisorDepartment: null,
    supervisorPosition: null,
    supervisorPhotoUrl: null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

// 실무 경험 슬롯 placeholder (2026-06-04 슬롯 정책 + 적용 시점 분리).
//   - 필수 슬롯(1·2·3·5): "신정책 적용 주차"(buildSlotFailWeekIds — 판정 완료 + 테스트 사용자
//     전 주차 / 실사용자 EFFECTIVE_FROM 이후)에서는 라인 행이 없어도 항상 오픈/마감 간주 →
//     강화 실패 placeholder(status="fail", 내용 없음, 해당 없음 불가).
//   - fail 선반영 금지: 진행 중(running)·집계 중(tallying) 주차는 아직 N+1 판정 시점 전이므로
//     not_opened(해당 없음/보이드)로 내린다. 휴식/전환 주차·실사용자 과거 주차도 not_opened.
//   - 확장 슬롯(4): 정해진 주차에만 열린다 → 미개설 주차는 항상 해당 없음
//     (status="void", enhancementStatus=not_applicable).
function experienceSlotPlaceholderLine(
  weekId: string | null,
  slotOrder: 1 | 2 | 3 | 4 | 5,
  kind: "required_fail" | "not_opened",
): Cluster4LineDetailDto {
  const base = emptyLine("experience", weekId, kind === "required_fail");
  return {
    ...base,
    ...(kind === "required_fail"
      ? { status: "fail" as const, statusLabel: lineStatusLabel("fail") }
      : {}),
    experienceSlotOrder: slotOrder,
    experienceCategory: EXPERIENCE_SLOT_CATEGORY[slotOrder],
  };
}

// 실무 역량 "강화 대기" placeholder (2026-06-04 v14 단일 정규화).
//   역량은 선택 과제 — 1인·1주차 항상 1칸이며 해당 없음(not_applicable)이 존재할 수 없다.
//   라인이 0개(미개설 포함)면 보이드 칸(status="void", 내용 없음)에 enhancementStatus="pending"
//   ("강화 대기")을 실어 분모 A=1 을 유지한다. (휴식/전환 주차는 기존 na placeholder — 집계 제외.)
//   ⚠ 미확정(running/tallying) 주차 전용 — 확정(공표) 주차는 competencyFailPlaceholderLine 사용.
function competencyPendingPlaceholderLine(
  weekId: string | null,
): Cluster4LineDetailDto {
  return {
    ...emptyLine("competency", weekId, false),
    enhancementStatus: "pending",
    submissionStatus: "not_submitted",
    enhancementReason: "competency_optional_pending",
  };
}

// 실무 역량 확정(공표) 주차 placeholder (2026-06-04 v14.1 보정).
//   "강화 대기"는 미확정(running/tallying) 주차에서만 가능 — result_published_at 이 찍힌
//   확정 주차에서 선택 과제 미수행(라인 0개)은 더 이상 수행할 수 없으므로 "강화 실패"다.
//   den 정합: growth 경로 abilityNormalized 는 비휴식 주차 A=1·B=0(성공 없음)으로 이미
//   미수행=미완료로 집계하므로, fail(분모 포함) 표시가 den/num 수식과 1:1 — 수식 무변경.
//   표시: competency fail=보이드(v11) — status="void" 유지, 배지만 강화 실패.
function competencyFailPlaceholderLine(
  weekId: string | null,
): Cluster4LineDetailDto {
  return {
    ...emptyLine("competency", weekId, false),
    enhancementStatus: "fail",
    submissionStatus: "not_submitted",
    enhancementReason: "competency_optional_unfulfilled_confirmed",
  };
}

// 개설됐지만 본인이 미배정인 info/experience 라인의 "강화 실패" DTO (2026-06-02).
//   - 정책: info/experience 의 미배정 fail 은 보이드가 아니라 개설된 라인 내용을 노출한다.
//     (competency 만 보이드 유지. career 는 2026-06-02 개정으로 fail 이 아니라 not_applicable +
//      내용 노출 → openedCareerLineDetail 가 전담한다. 이 함수는 info/experience 전용.)
//   - lineTargetId=null (본인 타깃 없음) → canEdit=false / editReason="target_missing" 고정.
//   - 내용(main_title/line_code/output_*)은 cluster4_lines(운영자 1차 입력)에서 가져온다.
//     사용자 2차 submission 은 없으므로 submission=null, infoSubtitle/growthPoint=null.
//   - enhancementStatus=fail (computeCluster4Enhancement 의 미배정+개설 분기와 동일 기준).
//   - status="fail"(미기입) — 보이드("void")가 아니므로 프론트가 내용을 렌더한다.
function openedFailLineDetail(
  line: NonNullable<TargetWithLineRow["cluster4_lines"]>,
  weekId: string,
  partType: Extract<Cluster4LinePartType, "information" | "experience">,
  activityTypeNameById: Map<string, string>,
  experienceMasterMetaById: Map<string, ExperienceMasterMeta>,
  infoDisplayCodeByActivityTypeId: Map<string, string>,
): Cluster4LineDetailDto {
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: false,
    expectedWhenMissing: true, // 개설됨 + 미배정 → fail
  });
  const activityTypeId =
    partType === "information" ? line.activity_type_id : null;
  const experienceLineMasterId =
    partType === "experience" ? line.experience_line_master_id : null;
  const adminOutputLinks = resolveOutputLinks(line.output_links, [line.output_link_1]);
  const adminOutputImageItems = normalizeOutputImages(line.output_images);
  const adminOutputImages = adminOutputImageItems.map((i) => i.url);
  const adminOutputImageCaptions = adminOutputImageItems.map((i) => i.caption);
  return {
    partType,
    status: "fail",
    statusLabel: lineStatusLabel("fail"),
    enhancementStatus: enhancement.enhancementStatus,
    submissionStatus: enhancement.submissionStatus,
    enhancementReason: enhancement.enhancementReason,
    lineId: line.id,
    lineTargetId: null,
    targetMode: null,
    // experience 만 마스터 line_name. information 은 마스터 line_name 이 없어 null.
    lineName:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.lineName ?? null
        : null,
    mainTitle: line.main_title,
    infoSubtitle: null,
    infoGrowthPoint: null,
    outputLink1: line.output_link_1,
    outputLinks: adminOutputLinks,
    outputImages: adminOutputImages,
    outputImageCaptions: adminOutputImageCaptions,
    adminOutputLinkCount: adminOutputLinks.length,
    adminOutputImageCount: adminOutputImages.length,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    weekId,
    activityTypeId,
    activityTypeKey: activityTypeId,
    activityTypeName: activityTypeId
      ? (activityTypeNameById.get(activityTypeId) ?? null)
      : null,
    competencyLineMasterId: null,
    experienceLineMasterId,
    experienceRating: null,
    experienceCategory:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.category ?? null
        : null,
    experienceSlotOrder:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.slotOrder ?? null
        : null,
    careerProjectId: null,
    careerGrade: null,
    careerGradePoints: null,
    careerRatingStatus: null,
    lineCode: line.line_code,
    // 고객 표시용 공식 코드 — experience 는 마스터 메타(registration 우선), information 은
    // line_registrations(hub='info') 운영자 코드(IFBS-NN000X, /admin/lines/info SoT). 미상이면 null
    // (센티넬/내부 코드 노출 방지 → 고객 화면 숨김).
    displayLineCode:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.displayLineCode ?? null
        : partType === "information" && activityTypeId
          ? infoDisplayCodeByActivityTypeId.get(activityTypeId) ?? null
          : null,
    projectCode: null,
    companyName: null,
    companyLogoUrl: null,
    supervisorName: null,
    supervisorDepartment: null,
    supervisorPosition: null,
    supervisorPhotoUrl: null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

// 개설됐지만 본인 미선발/미배정인 career 라인 DTO (2026-06-02 career 정책 개정).
//   - 정책: career 의 미선발/미배정은 fail 이 아니라 not_applicable("해당 없음")을 유지한다.
//     (info/experience 의 openedFailLineDetail=fail 과 다름. competency 는 보이드 유지.)
//   - 단, 그 주차에 개설된 career 라인이 있으면 라인 칸·모달에 개설 라인의 content 를 노출한다:
//     mainTitle/outputLinks/outputImages/projectCode/companyName/sponsor 메타/lineName.
//     → status='void'(보이드/미개설 표시축) 이지만 표시용 필드는 null/empty 가 아니다.
//   - enhancementStatus='not_applicable' (computeCluster4Enhancement:
//       hasTarget=false, expectedWhenMissing=false, isCareer=true →
//       enhancementReason='target_missing_not_required_career').
//   - lineTargetId=null (본인 타깃 없음) → canEdit=false / editReason='target_missing' 고정.
//   - 내용은 cluster4_lines(운영자 1차 입력) + career_projects(sponsor 메타)에서 가져온다.
//     사용자 2차 submission 은 없으므로 submission=null, infoSubtitle/growthPoint=null.
//   - 타깃이 없어 평점 eval 도 없으므로 careerGrade/careerGradePoints=null,
//     careerRatingStatus=unevaluated(=null grade).
function openedCareerLineDetail(
  line: NonNullable<TargetWithLineRow["cluster4_lines"]>,
  weekId: string,
  careerProjectMetaById: Map<string, CareerProjectMeta>,
): Cluster4LineDetailDto {
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: true,
    expectedWhenMissing: false, // career 미선발 → not_applicable("해당 없음") 유지
  });
  const careerProjectId = line.career_project_id;
  const careerMeta = careerProjectId
    ? careerProjectMetaById.get(careerProjectId) ?? null
    : null;
  const adminOutputLinks = resolveOutputLinks(line.output_links, [line.output_link_1]);
  const adminOutputImageItems = normalizeOutputImages(line.output_images);
  const adminOutputImages = adminOutputImageItems.map((i) => i.url);
  const adminOutputImageCaptions = adminOutputImageItems.map((i) => i.caption);
  return {
    partType: "career",
    // status 축은 void(보이드/미개설 표시) — 평가 축(enhancementStatus)은 not_applicable.
    status: "void",
    statusLabel: lineStatusLabel("void"),
    enhancementStatus: enhancement.enhancementStatus,
    submissionStatus: enhancement.submissionStatus,
    enhancementReason: enhancement.enhancementReason,
    lineId: line.id,
    lineTargetId: null,
    targetMode: null,
    lineName: careerMeta?.lineName ?? null,
    mainTitle: line.main_title,
    infoSubtitle: null,
    infoGrowthPoint: null,
    outputLink1: line.output_link_1,
    outputLinks: adminOutputLinks,
    outputImages: adminOutputImages,
    outputImageCaptions: adminOutputImageCaptions,
    adminOutputLinkCount: adminOutputLinks.length,
    adminOutputImageCount: adminOutputImages.length,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    weekId,
    activityTypeId: null,
    activityTypeKey: null,
    activityTypeName: null,
    competencyLineMasterId: null,
    experienceLineMasterId: null,
    experienceRating: null,
    experienceCategory: null,
    experienceSlotOrder: null,
    careerProjectId,
    careerGrade: null,
    careerGradePoints: null,
    careerRatingStatus: careerRatingStatusFromGrade(null),
    lineCode: line.line_code,
    // 고객 표시용 공식 코드 = career_projects.line_code(careerMeta). 미상이면 null(숨김).
    displayLineCode: careerMeta?.displayLineCode ?? null,
    // career part 의 line_code 는 career_projects.line_code 와 동일 (= projectCode).
    projectCode: line.line_code,
    // sponsor-card 메타 (career_projects).
    companyName: careerMeta?.companyName ?? null,
    companyLogoUrl: careerMeta?.companyLogoUrl ?? null,
    supervisorName: careerMeta?.supervisorName ?? null,
    supervisorDepartment: careerMeta?.supervisorDepartment ?? null,
    supervisorPosition: careerMeta?.supervisorPosition ?? null,
    supervisorPhotoUrl: careerMeta?.supervisorPhotoUrl ?? null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

// 개설됐지만 본인 미배정인 competency 라인의 "강화 실패(보이드 표시)" DTO.
//   - 2026-06-04 정책 재개정: competency 강화 실패는 보이드로 표시한다 —
//     status="void"(보이드/미개설 표시축) + enhancementStatus="fail"(판정축).
//     (2026-06-02 의 "fail + content 노출" 재개정을 되돌림. 판정축 fail 은 유지되므로
//      강화율 분모 A 에는 그대로 포함된다 — 보이드 '표시'이지 해당 없음이 아니다.)
//   - lineTargetId=null (본인 타깃 없음) → canEdit=false / editReason="target_missing" 고정 → 읽기 전용.
//   - content(lineName/lineCode/mainTitle/output_*)는 진단/어드민 활용을 위해 계속 채워 내려준다.
//     프론트는 status="void" 기준으로 빈 칸(보이드)을 렌더한다.
function openedCompetencyFailLineDetail(
  line: NonNullable<TargetWithLineRow["cluster4_lines"]>,
  weekId: string,
  competencyMasterMetaById: Map<string, CompetencyMasterMeta>,
): Cluster4LineDetailDto {
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: false,
    expectedWhenMissing: true, // 개설됨 + 미배정 → fail
  });
  const competencyLineMasterId = line.competency_line_master_id;
  const adminOutputLinks = resolveOutputLinks(line.output_links, [line.output_link_1]);
  const adminOutputImageItems = normalizeOutputImages(line.output_images);
  const adminOutputImages = adminOutputImageItems.map((i) => i.url);
  const adminOutputImageCaptions = adminOutputImageItems.map((i) => i.caption);
  return {
    partType: "competency",
    // 표시축 = 보이드(2026-06-04). 판정축(enhancementStatus)은 fail 그대로.
    status: "void",
    statusLabel: lineStatusLabel("void"),
    enhancementStatus: enhancement.enhancementStatus,
    submissionStatus: enhancement.submissionStatus,
    enhancementReason: enhancement.enhancementReason,
    lineId: line.id,
    lineTargetId: null,
    targetMode: null,
    lineName: competencyLineMasterId
      ? competencyMasterMetaById.get(competencyLineMasterId)?.lineName ?? null
      : null,
    mainTitle: line.main_title,
    infoSubtitle: null,
    infoGrowthPoint: null,
    outputLink1: line.output_link_1,
    outputLinks: adminOutputLinks,
    outputImages: adminOutputImages,
    outputImageCaptions: adminOutputImageCaptions,
    adminOutputLinkCount: adminOutputLinks.length,
    adminOutputImageCount: adminOutputImages.length,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    weekId,
    activityTypeId: null,
    activityTypeKey: null,
    activityTypeName: null,
    competencyLineMasterId,
    experienceLineMasterId: null,
    experienceRating: null,
    experienceCategory: null,
    experienceSlotOrder: null,
    careerProjectId: null,
    careerGrade: null,
    careerGradePoints: null,
    careerRatingStatus: null,
    lineCode: line.line_code,
    // 고객 표시용 공식 코드 — competency 마스터 메타(registration 우선). 미상이면 null(숨김).
    displayLineCode: competencyLineMasterId
      ? competencyMasterMetaById.get(competencyLineMasterId)?.displayLineCode ?? null
      : null,
    projectCode: null,
    companyName: null,
    companyLogoUrl: null,
    supervisorName: null,
    supervisorDepartment: null,
    supervisorPosition: null,
    supervisorPhotoUrl: null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

function toSubmissionDto(row: SubmissionRow): Cluster4LineSubmissionDto {
  const images = normalizeOutputImages(row.output_images);
  return {
    id: row.id,
    lineTargetId: row.line_target_id,
    subtitle: row.subtitle,
    growthPoint: row.growth_point ?? null,
    outputLink2: row.output_link_2,
    outputLink3: row.output_link_3,
    outputLink4: row.output_link_4,
    outputLink5: row.output_link_5,
    outputLinks: resolveOutputLinks(row.output_links, [
      row.output_link_2,
      row.output_link_3,
      row.output_link_4,
      row.output_link_5,
    ]),
    outputImages: images.map((i) => i.url),
    outputImageCaptions: images.map((i) => i.caption),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function computeLineStatus(
  target: TargetWithLineRow,
  submission: SubmissionRow | null,
): Cluster4LineDetailDto["status"] {
  if (submission) return "success";
  const closesAt = target.cluster4_lines?.submission_closes_at;
  if (closesAt && Date.now() > new Date(closesAt).getTime()) return "fail";
  return "pending";
}

function lineStatusLabel(status: Cluster4LineDetailDto["status"]): string {
  switch (status) {
    case "void":
      return "미개설";
    case "pending":
      return "기입 대기";
    case "success":
      return "기입 완료";
    case "fail":
      return "미기입";
  }
}

function toLineDetail(
  target: TargetWithLineRow,
  submission: SubmissionRow | null,
  activityTypeNameById: Map<string, string>,
  experienceRatingByTargetId: Map<string, number>,
  experienceMasterMetaById: Map<string, ExperienceMasterMeta>,
  careerGradeByTargetId: Map<string, CareerGradeEval>,
  careerProjectMetaById: Map<string, CareerProjectMeta>,
  competencyMasterMetaById: Map<string, CompetencyMasterMeta>,
  infoDisplayCodeByActivityTypeId: Map<string, string>,
): Cluster4LineDetailDto | null {
  const line = target.cluster4_lines;
  if (!line) return null;
  const status = computeLineStatus(target, submission);
  const partType = toPublicPart(line.part_type);
  // sub-line 식별자는 part_type 별로 다른 컬럼을 쓴다 — 다른 part 의 라인에는 null.
  const activityTypeId =
    partType === "information" ? line.activity_type_id : null;
  const competencyLineMasterId =
    partType === "competency" ? line.competency_line_master_id : null;
  const experienceLineMasterId =
    partType === "experience" ? line.experience_line_master_id : null;
  const careerProjectId =
    partType === "career" ? line.career_project_id : null;
  // 실무 경력 평점: cluster4_career_line_evaluations.grade / grade_points (현재 대상자 기준).
  // career part 만 매핑하고 그 외 part 는 null. 미평가면 null → careerRatingStatus="unevaluated".
  const careerEval =
    partType === "career" ? careerGradeByTargetId.get(target.id) ?? null : null;
  const careerGrade = careerEval?.grade ?? null;
  const careerGradePoints = careerEval?.points ?? null;
  const careerRatingStatus =
    partType === "career" ? careerRatingStatusFromGrade(careerGrade) : null;
  // sponsor-card 메타: career part 만 careerProjectId 로 career_projects 를 조회해 매핑.
  // 비career 또는 미연결/미존재면 전부 null (프론트 fallback).
  const careerMeta =
    partType === "career" && careerProjectId
      ? careerProjectMetaById.get(careerProjectId) ?? null
      : null;
  // 라인명: 각 part 의 마스터 line_name 만 사용 (main_title 과 절대 섞지 않음).
  //   information 은 마스터 line_name 이 없어 null (라벨은 activityTypeName).
  const lineName =
    partType === "experience" && experienceLineMasterId
      ? experienceMasterMetaById.get(experienceLineMasterId)?.lineName ?? null
      : partType === "competency" && competencyLineMasterId
        ? competencyMasterMetaById.get(competencyLineMasterId)?.lineName ?? null
        : partType === "career"
          ? careerMeta?.lineName ?? null
          : null;
  // 고객 표시용 공식 라인 코드: 각 part 의 마스터/registration line_code(공식형) 사용.
  //   개설 시 cluster4_lines.line_code 에 들어가는 내부 코드(날짜형 EXBS-EN241021 /
  //   센티넬 IF..-OPEN<ts> / info-OK-wisdom-2026w10)와 별개.
  //   information 은 line_registrations(hub='info') 의 운영자 코드(IFBS-NN000X)를 노출한다
  //   (활동유형명 매칭, /admin/lines/info SoT). 미상이면 null — 내부 lineCode 로 fallback 하지 않는다.
  const displayLineCode =
    partType === "experience" && experienceLineMasterId
      ? experienceMasterMetaById.get(experienceLineMasterId)?.displayLineCode ?? null
      : partType === "competency" && competencyLineMasterId
        ? competencyMasterMetaById.get(competencyLineMasterId)?.displayLineCode ?? null
        : partType === "career"
          ? careerMeta?.displayLineCode ?? null
          : partType === "information" && activityTypeId
            ? infoDisplayCodeByActivityTypeId.get(activityTypeId) ?? null
            : null;
  // 강화 상태: 타깃이 존재하므로(1차 대상자) 마감 여부로 success/pending 을 가른다.
  // 마감(submission_closes_at = 수 22:00 KST) 후면 미기입이라도 success.
  // career 는 추가로 평점을 반영한다 — 마감 후 D=fail / S~C=success / 미평가=pending(unevaluated).
  // submission 존재 여부는 submissionStatus 로만 분리 반영한다.
  const closesAt = line.submission_closes_at;
  const deadlinePassed =
    Boolean(closesAt) && Date.now() > new Date(closesAt).getTime();
  // 실무 경험 평점: experience part 만 매핑. rating <= 3 → 마감 후 fail.
  const experienceRatingValue =
    partType === "experience"
      ? experienceRatingByTargetId.get(target.id) ?? null
      : null;
  const experienceRatingVerdict =
    partType === "experience" && experienceRatingValue != null
      ? experienceRatingValue <= EXPERIENCE_RATING_FAIL_THRESHOLD
        ? "fail"
        : "pass"
      : undefined;
  const enhancement = computeCluster4Enhancement({
    hasTarget: true,
    deadlinePassed,
    hasSubmission: Boolean(submission),
    isCareer: partType === "career",
    // career 만 평점 verdict 를 전달한다. 비career 는 undefined → 기존 동작(마감 후 success).
    careerGradeVerdict: partType === "career" ? careerRatingStatus : undefined,
    // experience 만 평점 verdict 를 전달한다. rating<=3 → fail. 비experience 는 undefined.
    experienceRatingVerdict,
  });
  // 관리자(라인 개설/관리)가 입력한 결과물만 추린다 — 사용자 제출분(cluster4_line_submissions)은
  // 별도 source 이므로 여기 어디에도 섞이지 않는다. resolveOutputLinks 는 URL 없는 항목을
  // 버리므로 length 가 곧 "URL 이 있는 관리자 링크 수"다.
  const adminOutputLinks = resolveOutputLinks(line.output_links, [line.output_link_1]);
  // output_images 는 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → 정규화.
  const adminOutputImageItems = normalizeOutputImages(line.output_images);
  const adminOutputImages = adminOutputImageItems.map((i) => i.url);
  const adminOutputImageCaptions = adminOutputImageItems.map((i) => i.caption);
  // canEdit / editReason 은 placeholder. 호출부에서 evaluateCluster4HubEdit 결과로 덮어쓴다.
  return {
    partType,
    status,
    statusLabel: lineStatusLabel(status),
    enhancementStatus: enhancement.enhancementStatus,
    submissionStatus: enhancement.submissionStatus,
    enhancementReason: enhancement.enhancementReason,
    lineId: line.id,
    lineTargetId: target.id,
    targetMode: target.target_mode,
    // lineName ← master.line_name 만 / mainTitle ← cluster4_lines.main_title 만 (섞지 않음).
    lineName,
    mainTitle: line.main_title,
    // 실무 정보(information) 카드의 서브 타이틀·그로스 포인트는 크루원 제출값(submission)에서 내려준다.
    // (구: cluster4_lines.info_* 운영자 입력값 → deprecated). 제출 전이면 null. 그 외 part 는 null.
    infoSubtitle: partType === "information" ? (submission?.subtitle ?? null) : null,
    infoGrowthPoint: partType === "information" ? (submission?.growth_point ?? null) : null,
    outputLink1: line.output_link_1,
    outputLinks: adminOutputLinks,
    outputImages: adminOutputImages,
    outputImageCaptions: adminOutputImageCaptions,
    adminOutputLinkCount: adminOutputLinks.length,
    adminOutputImageCount: adminOutputImages.length,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    weekId: target.week_id,
    activityTypeId,
    // activity_types 의 PK 가 곧 string key (예: "community"). FK 컬럼 값이 그대로 key.
    activityTypeKey: activityTypeId,
    activityTypeName: activityTypeId
      ? (activityTypeNameById.get(activityTypeId) ?? null)
      : null,
    competencyLineMasterId,
    experienceLineMasterId,
    // 실무 경험 평점: cluster4_experience_line_evaluations.rating (현재 대상자 기준).
    // experience part 만 매핑하고 그 외 part 는 null. 미평가면 null.
    experienceRating: experienceRatingValue,
    // 실무 경험 5슬롯 분류: cluster4_experience_line_masters (experience_line_master_id 조인).
    // experience part 만 매핑하고 그 외 part 는 null. 미분류면 null.
    experienceCategory:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.category ?? null
        : null,
    experienceSlotOrder:
      partType === "experience" && experienceLineMasterId
        ? experienceMasterMetaById.get(experienceLineMasterId)?.slotOrder ?? null
        : null,
    careerProjectId,
    careerGrade,
    careerGradePoints,
    careerRatingStatus,
    lineCode: line.line_code,
    // 고객 표시용 공식 코드 (위 displayLineCode 계산값 — registration/master 우선, 미상 null).
    displayLineCode,
    // career part 의 line_code 는 career_projects.line_code 와 동일 (= projectCode).
    projectCode: partType === "career" ? line.line_code : null,
    // sponsor-card 메타 (career part 만 값, 그 외 null).
    companyName: careerMeta?.companyName ?? null,
    companyLogoUrl: careerMeta?.companyLogoUrl ?? null,
    supervisorName: careerMeta?.supervisorName ?? null,
    supervisorDepartment: careerMeta?.supervisorDepartment ?? null,
    supervisorPosition: careerMeta?.supervisorPosition ?? null,
    supervisorPhotoUrl: careerMeta?.supervisorPhotoUrl ?? null,
    submission: submission ? toSubmissionDto(submission) : null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

// part_type ↔ lineBreakdown 카테고리 매핑.
// info=information, ability=competency, experience=experience, career=career.
function breakdownForPart(
  breakdown: WeeklyCardLineBreakdown,
  partType: Cluster4LinePartType,
): WeeklyCardLineDetail {
  switch (partType) {
    case "information":
      return breakdown.info;
    case "competency":
      return breakdown.ability;
    case "experience":
      return breakdown.experience;
    case "career":
      return breakdown.career;
  }
}

// 강화율 A/B 를 카드의 라인 DTO(enhancementStatus)에서 직접 파생한다 (2026-06-04).
//   A(분모) = enhancementStatus ∈ {pending, success, fail} 인 칸 수
//             (해당 없음·보이드 = not_applicable → 분모 제외).
//   B(분자) = enhancementStatus === "success" 인 칸 수 (대기/실패 → 분자 제외).
// 별도 SQL 집계(weekly-growth 경로)와 어긋날 수 없도록 카드에 실제로 실린 칸을 그대로 센다 —
// "라인 칸은 강화 실패인데 헤더 강화율은 성공으로 카운트" 류의 불일치가 구조적으로 불가능해진다.
// (org 노출 필터·슬롯 placeholder·career 패딩까지 모두 반영된 최종 칸 집합 기준.)
function breakdownFromLines(
  lines: Cluster4LineDetailDto[],
): WeeklyCardLineBreakdown {
  const mk = (): WeeklyCardLineDetail => ({ completed: 0, available: 0 });
  const breakdown: WeeklyCardLineBreakdown = {
    info: mk(),
    ability: mk(),
    experience: mk(),
    career: mk(),
  };
  // 실무 정보 허브 dedupe (2026-07-01): 고객 정보 허브는 활동유형(activityTypeKey)당 카드 1칸만
  // 렌더한다(고정 9종, findCluster4Line first-match). 같은 활동유형에 라인이 2개 이상(예: 정규 라인 +
  // 수동 테스트 라인 calendar) 있으면 화면엔 1칸인데 이 집계가 라인 수(2)를 세어 "총 N개"·주차 성장률
  // 분모가 화면 칸 수보다 부풀었다(예: calendar 2개 → info 4 인데 화면 3칸). → info 는 활동유형당 첫
  // 등장 라인 1개만 집계한다(대표 = 배열 첫 라인 = 고객 findCluster4Line 과 동일 순서·상태). 첫 라인이
  // not_applicable 이면 그 유형은 화면에서도 faded(비활성)이므로 집계에서 빠진다(seen 마킹은 첫 등장에서,
  // 카운트는 na 제외 규칙 그대로 — 화면 활성 칸과 1:1). 다른 파트(competency/experience/career)는 렌더
  // 모델이 달라 불변. activityTypeKey 부재(비정상) info 라인은 dedupe 불가 → 기존대로 개별 집계(회귀 방지).
  const seenInfoTypes = new Set<string>();
  for (const line of lines) {
    if (line.partType === "information") {
      const typeKey = (line.activityTypeKey ?? line.activityTypeId ?? null) as string | null;
      if (typeKey) {
        if (seenInfoTypes.has(typeKey)) continue; // 같은 유형 2번째+ 라인 = 화면에도 안 뜨는 칸 → 집계 제외
        seenInfoTypes.add(typeKey);
      }
    }
    if (line.enhancementStatus === "not_applicable") continue;
    const detail = breakdownForPart(breakdown, line.partType);
    detail.available += 1;
    if (line.enhancementStatus === "success") detail.completed += 1;
  }
  return breakdown;
}

function emptyBreakdown(): WeeklyCardLineBreakdown {
  const mk = (): WeeklyCardLineDetail => ({ completed: 0, available: 0 });
  return { info: mk(), ability: mk(), experience: mk(), career: mk() };
}

function attachLineBreakdown(
  lines: Cluster4LineDetailDto[],
  breakdown: WeeklyCardLineBreakdown,
  isRest: boolean,
): Cluster4LineDetailDto[] {
  return lines.map((line) => {
    if (isRest) {
      // 휴식 주차: 가용 라인이 정의되지 않음 → null 로 노출.
      return { ...line, numerator: null, denominator: null, rate: null };
    }
    const b = breakdownForPart(breakdown, line.partType);
    if (b.available <= 0) {
      return { ...line, numerator: null, denominator: null, rate: null };
    }
    return {
      ...line,
      numerator: b.completed,
      denominator: b.available,
      rate: roundGrowthRate(b.completed, b.available),
    };
  });
}

function isRestWeek(status: WeekResultStatus): boolean {
  return status === "personal_rest" || status === "official_rest";
}

// v11 "필수 슬롯 fail" 적용 주차 집합 (CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM 주석 참고).
//   포함 조건: weekId 존재 && 판정 완료(resultStatus success|fail) && 비전환 주차 &&
//             start_date >= EFFECTIVE_FROM (= 허브/라인 체계 적용 주차. 레거시 주차는
//             통합 라인 정책으로 별도 처리 — 사용자 유형 구분 없음).
//   running/tallying(아직 N+1 판정 시점 전 — fail 선반영 금지)·휴식·전환·레거시 주차는
//   제외 → 필수 슬롯 placeholder 가 해당 없음(not_opened)으로 내려간다.
//   weekly-growth 경로의 slotPolicyWeekIds(공표·현재주 기준)와 동일 의미 — resolver 의
//   resultStatus 가 공표/현재주 판정을 이미 반영하므로 여기선 상태값으로 가른다.
function buildSlotFailWeekIds(
  cards: WeeklyCardDto[],
  effectiveFrom: string = CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (!c.weekId || c.isTransition) continue;
    if (c.resultStatus !== "success" && c.resultStatus !== "fail") continue;
    if (c.startDate < effectiveFrom) continue;
    out.add(c.weekId);
  }
  return out;
}

// 레거시(허브 도입 전) 주차 집합 — 통합 라인 단일 렌더 게이트용 (2026-06-05 정책).
//   start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM (= 2026 여름 W1) 인 모든 카드 주차.
function buildLegacyWeekIds(
  cards: WeeklyCardDto[],
  effectiveFrom: string = CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (!c.weekId) continue;
    if (c.startDate < effectiveFrom) out.add(c.weekId);
  }
  return out;
}

function toUserWeekStatus(status: WeekResultStatus): Cluster4UserWeekStatus {
  return status;
}

function statusTone(status: WeekResultStatus): Cluster4StatusTone {
  switch (status) {
    case "success":
      return "success";
    case "fail":
      return "danger";
    case "personal_rest":
    case "official_rest":
      return "warning";
    case "running":
    case "tallying":
      return "info";
  }
}

// section1-title 정규화: 최종 형식 `${year} ${seasonName} 시즌, ${weekNumber}주차`.
// 입력 source 가 섞여 있어도 (DB "2026년도 봄시즌" / fallback "봄 시즌" / "" / season_key 단독)
// 모든 사용자에 대해 동일한 형식으로 통일된다. displayTitle/titleText/weekLabel/weekTitle 공통 source.
const SECTION1_SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};
const SECTION1_SEASON_NAMES_KO = ["봄", "여름", "가을", "겨울"];

function extractSeasonNameKo(
  seasonName: string | null | undefined,
  seasonKey: string | null | undefined,
): string | null {
  if (seasonKey) {
    for (const part of seasonKey.split("-")) {
      const mapped = SECTION1_SEASON_KEY_TO_KO[part.toLowerCase()];
      if (mapped) return mapped;
    }
  }
  if (seasonName) {
    for (const name of SECTION1_SEASON_NAMES_KO) {
      if (seasonName.includes(name)) return name;
    }
  }
  return null;
}

function extractYear(
  seasonYear: number | null | undefined,
  seasonKey: string | null | undefined,
  seasonName: string | null | undefined,
): number | null {
  if (typeof seasonYear === "number" && seasonYear > 0) return seasonYear;
  if (seasonKey) {
    const m = seasonKey.match(/(\d{4})/);
    if (m) return Number(m[1]);
  }
  if (seasonName) {
    const m = seasonName.match(/(\d{4})/);
    if (m) return Number(m[1]);
  }
  return null;
}

function formatSection1Title(
  seasonYear: number | null | undefined,
  seasonName: string | null | undefined,
  seasonKey: string | null | undefined,
  weekNumber: number,
): string {
  const year = extractYear(seasonYear, seasonKey, seasonName);
  const season = extractSeasonNameKo(seasonName, seasonKey);
  const weekPart = `${weekNumber}주차`;
  if (year != null && season) return `${year} ${season} 시즌, ${weekPart}`;
  if (season) return `${season} 시즌, ${weekPart}`;
  if (year != null) return `${year}, ${weekPart}`;
  return weekPart;
}

// ── section1-header status-badge 아이콘 매핑 (백엔드 SoT) ──
// userWeekStatus 와 1:1. statusTone(semantic) 으로는 personal/official rest 와
// running/tallying 을 구분하지 못하므로 별도 매핑이 필요하다.
// 경로는 ASCII 파일명으로 통일한다 — 한글/공백/괄호 파일명(icon - 성장 (집계 중).png 등)은
// 일부 서빙 환경(프록시/CDN/정적 핸들러)에서 %20%28 인코딩으로 404 가 난다. 프론트 방어 로직에
// 의존하지 않고 API 가 처음부터 안전한 ASCII 경로를 내려준다. (기존 한글 파일은 삭제하지 않음.)
const STATUS_ICON_URL: Record<Cluster4StatusIconKey, string> = {
  success: "/images/0/cluster4/icon/icon-growth-success.png",
  fail: "/images/0/cluster4/icon/icon-growth-fail.png",
  running: "/images/0/cluster4/icon/icon-growth-running.png",
  tallying: "/images/0/cluster4/icon/icon-growth-tallying.png",
  personal_rest: "/images/0/cluster4/icon/icon-rest-personal.png",
  official_rest: "/images/0/cluster4/icon/icon-rest-official.png",
};

function statusIconUrl(key: Cluster4StatusIconKey): string {
  return STATUS_ICON_URL[key];
}

// 본 주차 진행 라벨. running/tallying 은 결과 미확정이므로 확정 누적(approved)에 표시용으로
// +1 한 값을 보여준다 (정책 5: 예) 1/25 → 2/25). 실제 DB 카운트는 올리지 않는다.
// 그 외 (success/fail/personal_rest/official_rest) 는 accumulatedApprovedWeeks 그대로.
// "주차" 접미사는 i18n 영향 받지만 현재 화면이 한국어 고정이므로 그대로 둔다.
function buildWeekProgressLabel(
  status: Cluster4UserWeekStatus,
  approved: number,
  target: number,
): string {
  const displayCount =
    status === "running" || status === "tallying" ? approved + 1 : approved;
  return `${displayCount} / ${target} 주차`;
}

function cardMessage(card: WeeklyCardDto): string | null {
  if (card.resultStatus === "personal_rest") return "개인 휴식주";
  if (card.resultStatus === "official_rest") return "공식 휴식주";
  if (card.resultStatus === "running") return "성장 진행 중";
  if (card.resultStatus === "tallying") return "집계 중";
  return null;
}

type DetailLogPreviousWeekStatus = "success" | "fail" | "none" | "rest";

function detailLogPreviousStatus(
  card: Cluster4WeeklyCardDto | null,
): DetailLogPreviousWeekStatus {
  if (!card) return "none";
  if (card.isTransition || card.userWeekStatus === "personal_rest" || card.userWeekStatus === "official_rest") {
    return "rest";
  }
  if (card.userWeekStatus === "success" || card.userWeekStatus === "fail") {
    return card.userWeekStatus;
  }
  return "none";
}

function withDetailLogMessageMeta(
  cards: Cluster4WeeklyCardDto[],
): Cluster4WeeklyCardDto[] {
  const chronological = cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) =>
      a.card.startDate < b.card.startDate
        ? -1
        : a.card.startDate > b.card.startDate
          ? 1
          : a.index - b.index,
    );

  const out = [...cards];
  let previous: Cluster4WeeklyCardDto | null = null;
  let successStreak = 0;

  for (const { card, index } of chronological) {
    const previousWeekStatus = detailLogPreviousStatus(previous);
    const currentWeekStatus =
      card.userWeekStatus === "success" || card.userWeekStatus === "fail"
        ? card.userWeekStatus
        : null;

    if (currentWeekStatus) {
      successStreak =
        currentWeekStatus === "success" && previousWeekStatus === "success"
          ? successStreak + 1
          : currentWeekStatus === "success"
            ? 1
            : 0;
      out[index] = {
        ...card,
        detailLogMessageMeta: {
          previousWeekStatus,
          currentWeekStatus,
          successStreakWeeks: Math.min(successStreak, 10),
        },
      };
    } else {
      successStreak = 0;
    }

    previous = card;
  }

  return out;
}

type HeaderExtras = {
  generation: number | null;
  managedTeamName: string | null;
  isOnboarding: boolean;
};

function toWeeklyCardDto(
  card: WeeklyCardDto,
  lines: Cluster4LineDetailDto[],
  extras: HeaderExtras,
  people: WeeklyPeople,
): Cluster4WeeklyCardDto {
  const title = formatSection1Title(
    card.seasonYear,
    card.seasonName,
    card.seasonKey,
    card.weekNumber,
  );
  const imageUrl = card.weekImagePath || null;
  const rest = isRestWeek(card.resultStatus);
  const fmScore = card.totalFmScoreRaw;
  // 강화율 A/B: 카드에 실린 라인 칸의 enhancementStatus 에서 직접 파생 (2026-06-04 정합 정책).
  // 휴식 주차는 기존대로 분모 0(전부 null 노출). card.lineBreakdown(SQL 집계)은 더 이상
  // 카드 표시에 쓰지 않는다 — weekly-growth 단독 경로 전용으로만 남는다.
  const breakdown = rest ? emptyBreakdown() : breakdownFromLines(lines);
  const completedLines =
    breakdown.info.completed +
    breakdown.ability.completed +
    breakdown.experience.completed +
    breakdown.career.completed;
  const availableLines =
    breakdown.info.available +
    breakdown.ability.available +
    breakdown.experience.available +
    breakdown.career.available;
  const linesWithBreakdown = attachLineBreakdown(lines, breakdown, rest);
  const userWeekStatusValue = toUserWeekStatus(card.resultStatus);
  // statusIconKey = userWeekStatus (1:1). icon URL 은 정적 매핑.
  const iconKey: Cluster4StatusIconKey = userWeekStatusValue;
  const progressLabel = buildWeekProgressLabel(
    userWeekStatusValue,
    card.accumulatedApprovedWeeks,
    card.targetWeeks,
  );

  return {
    weekId: card.weekId,
    weekNumber: card.weekNumber,
    weekLabel: title,
    weekTitle: title,
    displayTitle: title,
    startDate: card.startDate,
    endDate: card.endDate,
    // 시즌 단위 집계(area-6-circles) 그룹 키 + 전환주차 제외 플래그 (v10, snapshot 저장).
    seasonKey: card.seasonKey,
    isTransition: card.isTransition,
    userWeekStatus: userWeekStatusValue,
    statusLabel: card.resultLabel,
    statusTone: statusTone(card.resultStatus),
    isRestWeek: rest,

    teamName: card.teamNameRaw,
    partName: card.partNameRaw,
    roleLabel: card.roleLabelRaw,
    membershipStatusLabel: card.membershipStatusLabelRaw,

    // 포인트 표시 정책(2026-06-04 통일): 고객 노출 DTO 는 표시 최종값만 담는다.
    //   별 = check(points) · 방패 = net(advantages−penalty) · 번개 = −penalty.
    //   raw advantage 는 DB/내부 집계 전용 — 고객 DTO 로 내보내지 않는다.
    //   null 시멘틱 유지: 원천 row 부재 시 null (별/방패/번개 동일).
    points: {
      star: card.pointsRaw,
      shield:
        card.advantagesRaw === null && card.penaltyRaw === null
          ? null
          : (card.advantagesRaw ?? 0) - (card.penaltyRaw ?? 0),
      lightning: card.penaltyRaw === null ? null : -card.penaltyRaw,
    },
    cumulativeInjeolmi: card.cumulativeAdvantages,
    fameScore: fmScore,
    fmScore,

    reputationCount: card.weeklyReputationCountRaw,
    reputationTotal: REPUTATION_TARGET,
    colleagueCount: card.linkedCrewCountRaw,
    colleagueTotal: COLLEAGUE_TARGET,

    // ── 위클리 평판 / 연계 동료 상세 (append-only) ──
    // reputationSummary.fm = 받은 평판 rating 합(≤4건). fameScore/fmScore(누적 포인트)와 별개.
    reputationSummary: people.reputationSummary,
    colleagueSummary: people.colleagueSummary,
    weeklyReputations: people.weeklyReputations,
    weeklyColleagues: people.weeklyColleagues,

    // 라인 칸 파생값(breakdownFromLines)과 동일 source — 칸 상태와 헤더 수치 정합 보장.
    weeklyGrowthRate: roundGrowthRate(completedLines, availableLines),
    growthNumerator: completedLines,
    growthDenominator: availableLines,

    // 실무 경험 허브 강화율 — 동일 breakdown.experience SoT 노출(프론트 Detail Log·카드 본문 단일 출처).
    //   레거시(2026 여름 W1 이전) 주차는 [통합] 주차 활동 내역(통합 임시 라인)이 experience 라인으로
    //   집계에 실리므로 total(=available)에 자동 포함된다. 휴식 주차는 breakdown 이 비어 0/0/0.
    experienceRate: {
      count: breakdown.experience.completed,
      total: breakdown.experience.available,
      rate: roundGrowthRate(breakdown.experience.completed, breakdown.experience.available),
    },

    // 실무 경험 필수 슬롯(도출/분석/평가) 성장 판정 — 백엔드 verdict 그대로 패스스루.
    // (WeeklyCardDto.experienceGrowth 의 string-literal union 은 Cluster4ExperienceGrowth 에 구조적으로 대입 가능)
    experienceGrowth: card.experienceGrowth,
    imageUrl,
    thumbnailUrl: imageUrl,
    cardMessage: cardMessage(card),
    titleText: title,
    lines: linesWithBreakdown,

    // ── section1-header 보강 필드 ──
    statusIconKey: iconKey,
    statusIconUrl: statusIconUrl(iconKey),
    accumulatedApprovedWeeks: card.accumulatedApprovedWeeks,
    totalRequiredWeeks: card.targetWeeks,
    baseWeekCount: card.targetWeeks,
    displayWeekProgressLabel: progressLabel,
    generation: extras.generation,
    managedTeamName: extras.managedTeamName,
    isOnboarding: extras.isOnboarding,
  };
}

// activity_types.name 룩업 (sub-line "information" 라인에만 활용). cluster4_lines.
// activity_type_id 는 text PK 와 동일 — FK 가 없어 PostgREST nested select 가 안 되므로
// 별도 in() 쿼리로 한 번에 가져온다. 실패해도 name 만 null 로 폴백한다 (DTO 손상 방지).
async function fetchActivityTypeNamesByIds(
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("activity_types")
    .select("id,name")
    .in("id", ids);
  if (error) {
    console.warn("[cluster4/weekly-cards] activity_types lookup failed", {
      message: error.message,
    });
    return map;
  }
  for (const row of (data ?? []) as ActivityTypeRow[]) {
    map.set(row.id, row.name);
  }
  return map;
}

// info(실무 정보) sub-line 고객 표시용 공식 라인 코드 룩업.
//   info 라인은 experience/competency 처럼 master 브리지가 없어 displayLineCode 가 없었다.
//   /admin/lines/info(=line_registrations, hub='info')의 운영자 표시 코드(예: 위즈덤→IFBS-NN0001)를
//   고객 DTO 의 displayLineCode 로 노출한다 — 내부 코드(info-OK-wisdom-2026w10)는 매칭용 lineCode 로만 유지.
//   매핑: cluster4_lines.activity_type_id → activity_types.name → line_registrations.line_name → line_code.
//   실패/미연결이면 그 activity 는 맵에서 빠지고 displayLineCode=null(프론트 코드태그 숨김 — 내부코드 노출 금지).
async function fetchInfoDisplayCodeByActivityTypeIds(
  activityTypeIds: string[],
  activityTypeNameById: Map<string, string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (activityTypeIds.length === 0) return map;
  const names = Array.from(
    new Set(
      activityTypeIds
        .map((id) => activityTypeNameById.get(id))
        .filter((n): n is string => Boolean(n)),
    ),
  );
  if (names.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("line_name,line_code,is_active")
    .eq("hub", "info")
    .eq("is_active", true)
    .in("line_name", names);
  if (error) {
    console.warn("[cluster4/weekly-cards] info line_registrations lookup failed", {
      message: error.message,
    });
    return map;
  }
  // line_name → line_code (첫 active 우선; info registration 은 org=common 단일이라 충돌 없음).
  const codeByName = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ line_name: string; line_code: string | null }>) {
    if (r.line_code && !codeByName.has(r.line_name)) codeByName.set(r.line_name, r.line_code);
  }
  for (const id of activityTypeIds) {
    const name = activityTypeNameById.get(id);
    const code = name ? codeByName.get(name) : undefined;
    if (code) map.set(id, code);
  }
  return map;
}

// experience_line_master_id → {category, slotOrder} 일괄 룩업.
// experience sub-line 5슬롯 분류 노출용. 실패해도 카드를 깨뜨리지 않고 분류만 null 폴백한다.
async function fetchExperienceMasterMetaByIds(
  ids: string[],
): Promise<Map<string, ExperienceMasterMeta>> {
  const map = new Map<string, ExperienceMasterMeta>();
  if (ids.length === 0) return map;
  // (2E-4) registrations-first — bridged_master_id 역참조. 미커버 id 는 헬퍼 내부에서
  // 기존 마스터 fallback. 반환 shape/의미는 기존 마스터 쿼리와 등가 (2E-1 diff 0).
  const meta = await getExperienceMetaByMasterIdsRegFirst(ids);
  for (const [id, m] of meta) {
    map.set(id, {
      category: (m.category as Cluster4ExperienceCategory | null) ?? null,
      slotOrder: m.slotOrder,
      lineName: m.lineName,
      organizationSlug: m.organizationSlug,
      displayLineCode: m.lineCode,
    });
  }
  return map;
}

// competency_line_master_id → {line_name, organization_slug} 일괄 룩업.
//   lineName: DTO.lineName source. organizationSlug: org 노출 판정 SoT.
// competency 는 5슬롯/sponsor 메타가 없어 별도 메타 fetch 가 없었으므로 전용 룩업을 둔다.
// 실패해도 카드를 깨뜨리지 않고 meta 만 null 폴백한다.
async function fetchCompetencyMasterMetaByIds(
  ids: string[],
): Promise<Map<string, CompetencyMasterMeta>> {
  const map = new Map<string, CompetencyMasterMeta>();
  if (ids.length === 0) return map;
  // (2E-4) registrations-first + 마스터 fallback (헬퍼 내부) — shape 등가 유지.
  const meta = await getCompetencyMetaByMasterIdsRegFirst(ids);
  for (const [id, m] of meta) {
    map.set(id, {
      lineName: m.lineName,
      organizationSlug: m.organizationSlug,
      displayLineCode: m.lineCode,
    });
  }
  return map;
}

// career_project_id → sponsor-card 메타 일괄 룩업 (career sub-line 표시용).
// companyName 의 SoT = career_projects.company_name (supervisor_company 아님).
// 실패해도 카드를 깨뜨리지 않고 메타만 null 폴백한다.
async function fetchCareerProjectMetaByIds(
  ids: string[],
): Promise<Map<string, CareerProjectMeta>> {
  const map = new Map<string, CareerProjectMeta>();
  if (ids.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("career_projects")
    .select(
      "id,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img,line_name,line_code,organization_slug",
    )
    .in("id", ids);
  if (error) {
    console.warn("[cluster4/weekly-cards] career_projects lookup failed", {
      message: error.message,
    });
    return map;
  }
  for (const row of (data ?? []) as {
    id: string;
    company_name: string | null;
    company_logo_url: string | null;
    supervisor_name: string | null;
    supervisor_department: string | null;
    supervisor_position: string | null;
    supervisor_profile_img: string | null;
    line_name: string | null;
    line_code: string | null;
    organization_slug: string | null;
  }[]) {
    map.set(row.id, {
      companyName: row.company_name ?? null,
      companyLogoUrl: row.company_logo_url ?? null,
      supervisorName: row.supervisor_name ?? null,
      supervisorDepartment: row.supervisor_department ?? null,
      supervisorPosition: row.supervisor_position ?? null,
      supervisorPhotoUrl: row.supervisor_profile_img ?? null,
      lineName: row.line_name ?? null,
      organizationSlug: row.organization_slug ?? null,
      displayLineCode: row.line_code ?? null,
    });
  }
  return map;
}

function toPermissionTarget(target: TargetWithLineRow | null) {
  if (!target) return null;
  const line = target.cluster4_lines;
  return {
    target_mode: target.target_mode,
    target_user_id: target.target_user_id,
    line: line
      ? {
          is_active: line.is_active,
          submission_opens_at: line.submission_opens_at,
          submission_closes_at: line.submission_closes_at,
        }
      : null,
  };
}

// user_edit_windows.cluster4.work_* override 를 DB part_type 별로 인덱싱한다.
// 각 part 마다 주차별 행(byWeek) + 전역(week_id=NULL) 행(global) 을 분리 보관한다.
//   - 주차별 행: 2026-06-08 도입. 관리자가 (카드종류, 시즌, 주차) 단위로 추가 개방한 것.
//   - 전역 행: legacy. week_id=NULL → 해당 허브 전 주차를 여는 기존 grant(하위호환).
// 카드별 판정은 resolveHubEditWindow 가 (카드 주차 OR 전역) additive OR 로 고른다.
async function fetchHubEditWindows(
  profileUserId: string,
): Promise<Map<DbLinePartType, HubEditWindowEntry>> {
  const map = new Map<DbLinePartType, HubEditWindowEntry>();
  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .select("resource_key,week_id,opened_at,expires_at")
    .eq("user_id", profileUserId)
    .in("resource_key", CLUSTER4_HUB_EDIT_WINDOW_KEYS as readonly string[]);

  if (error) {
    // 운영 환경에서 테이블/권한 문제로 실패해도 weekly-cards 전체 호출을 깨뜨리지 않는다.
    // override 없는 strict 정책으로 폴백 — 기존 동작과 동일.
    console.warn("[cluster4/weekly-cards] user_edit_windows lookup failed", {
      message: error.message,
    });
    return map;
  }

  for (const row of (data ?? []) as EditWindowDbRow[]) {
    const entry = Object.entries(PART_TYPE_TO_EDIT_WINDOW_KEY).find(
      ([, key]) => key === row.resource_key,
    );
    if (!entry) continue;
    const dbPart = entry[0] as DbLinePartType;
    let bucket = map.get(dbPart);
    if (!bucket) {
      bucket = { byWeek: new Map(), global: null };
      map.set(dbPart, bucket);
    }
    const snap: Cluster4EditWindowSnapshot = {
      openedAt: row.opened_at,
      expiresAt: row.expires_at,
    };
    if (row.week_id) {
      bucket.byWeek.set(row.week_id, snap);
    } else {
      bucket.global = snap;
    }
  }
  return map;
}

// org 라인 노출 필터의 기준값(fetchUserOrganizationSlug)은 lib/userOrg.ts 로 이관했다.
// snapshot 생성(이 파일)과 snapshot 조회 시 slug 접근 게이트(lib/pageAccess)가 동일 함수를
// 공유하도록 단일 출처로 통일한다(요구사항 #7).

// 사용자 현재 팀 id + 역할(파트장/에이전트) — 여름 주차 synthetic fail 팀/역할 스코프용.
//   역할 판정은 개설 단계(overallMemberStatus=memberStatusLabel)와 동일 함수로 정합 보장.
//   teamId 미해석(null)이면 팀 필터를 적용하지 않는다(fail-open — 기존 동작 보존).
async function fetchUserTeamAndRole(
  profileUserId: string,
): Promise<{ teamId: string | null; isPartLeader: boolean; isAgent: boolean }> {
  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("role,organization_slug")
    .eq("user_id", profileUserId)
    .maybeSingle();
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,membership_level,is_current")
    .eq("user_id", profileUserId);
  const memRows = (mems ?? []) as Array<{
    team_name: string | null;
    membership_level: string | null;
    is_current: boolean | null;
  }>;
  const cur = memRows.find((m) => m.is_current) ?? memRows[0] ?? null;
  const p = prof as { role: string | null; organization_slug: string | null } | null;
  const label = memberStatusLabel(p?.role ?? null, cur?.membership_level ?? null);
  let teamId: string | null = null;
  if (cur?.team_name && p?.organization_slug) {
    const { data: team } = await supabaseAdmin
      .from("cluster4_teams")
      .select("id")
      .eq("team_name", cur.team_name)
      .eq("organization_slug", p.organization_slug)
      .maybeSingle();
    teamId = (team as { id: string } | null)?.id ?? null;
  }
  return {
    teamId,
    isPartLeader: label === "심화(파트장)",
    isAgent: label === "심화(에이전트)",
  };
}

// 라인 마스터 organization_slug(폴백용)을 판정한다 — line_code/registration 으로 판정 불가일 때만 쓴다.
//   info        → org 컬럼 없음 → null(판정 불가).
//   experience  → cluster4_experience_line_masters.organization_slug
//   competency  → cluster4_competency_line_masters.organization_slug
//   career      → career_projects.organization_slug
// 마스터 미발견/null 이면 null(판정 불가).
function resolveMasterOrg(
  line: NonNullable<TargetWithLineRow["cluster4_lines"]>,
  experienceMasterMetaById: Map<string, ExperienceMasterMeta>,
  competencyMasterMetaById: Map<string, CompetencyMasterMeta>,
  careerProjectMetaById: Map<string, CareerProjectMeta>,
): LineOrgScope | null {
  switch (line.part_type) {
    case "info":
      return null;
    case "experience":
      return resolveLineScopeFromValues({
        partType: "experience",
        lineCode: null,
        masterOrg: line.experience_line_master_id
          ? experienceMasterMetaById.get(line.experience_line_master_id)?.organizationSlug
          : null,
      }).org;
    case "competency":
      return resolveLineScopeFromValues({
        partType: "competency",
        lineCode: null,
        masterOrg: line.competency_line_master_id
          ? competencyMasterMetaById.get(line.competency_line_master_id)?.organizationSlug
          : null,
      }).org;
    case "career":
      return resolveLineScopeFromValues({
        partType: "career",
        lineCode: null,
        masterOrg: line.career_project_id
          ? careerProjectMetaById.get(line.career_project_id)?.organizationSlug
          : null,
      }).org;
  }
}

// 라인의 노출 org 을 판정한다(최종 정책 — cluster4LineOrg.ts 우선순위).
//   1) line_code 토큰(BS>EC>OK>PX) 이 있으면 그것을 우선(코드에 BS 가 있으면 무조건 common).
//   2) line_code 로 판정 불가면 허브 마스터 organization_slug 로 폴백.
//   3) 둘 다 불가면 null(판정 불가) → 호출부에서 Step 2 숨김 / Step 1 허용.
function resolveLineOrg(
  line: NonNullable<TargetWithLineRow["cluster4_lines"]>,
  experienceMasterMetaById: Map<string, ExperienceMasterMeta>,
  competencyMasterMetaById: Map<string, CompetencyMasterMeta>,
  careerProjectMetaById: Map<string, CareerProjectMeta>,
): LineOrgScope | null {
  return resolveLineScopeFromValues({
    partType: line.part_type,
    lineCode: line.line_code,
    masterOrg: resolveMasterOrg(
      line,
      experienceMasterMetaById,
      competencyMasterMetaById,
      careerProjectMetaById,
    ),
  }).org;
}

// PostgREST 기본 1000행 cap 회피용 순수 페이지네이션 루프.
// pageFetcher 를 .range(from, to) 경계로 끝까지 호출해 모든 행을 모은다. 한 페이지가 pageSize
// 미만이면 종료한다. 호출부는 반드시 안정(unique) 정렬을 줘야 페이지 경계에서 행 누락/중복이 없다.
// supabase 의존 없이 fetcher 주입형으로 분리해 스모크에서 fake fetcher 로 단위 검증할 수 있게 한다.
export async function collectAllRows<T>(
  pageFetcher: (
    from: number,
    to: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await pageFetcher(from, from + pageSize - 1);
    if (error) throw new Cluster4WeeklyCardsError(500, error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// 그 주차에 개설된 "전 유저 타깃(+active 라인 content)"을 1000행 cap 없이 전수 수집한다.
//   - 본인 타깃은 호출부에서 필터하고, 그 외 유저의 타깃은 "개설 라인(누구든·mode 무관) = 행 존재"
//     판정(openedByWeek) + 미배정 라인 content 노출에 쓴다.
//   - 안정 정렬(created_at desc, id desc — id 로 tie-break)로 페이지 경계 안전. 정렬 자체는
//     openedByWeek 의 line.id 단위 dedup(대표 content 동일)·본인 real DTO 산정에 영향을 주지 않는다.
//   - career 포함/정렬과 무관하게 전 페이지를 모으므로 오래된 라인도 절대 누락되지 않는다(요구 4).
async function fetchAllLineTargetsByWeek(
  weekIds: string[],
): Promise<TargetWithLineRow[]> {
  if (weekIds.length === 0) return [];
  return collectAllRows<TargetWithLineRow>((from, to) => {
    let q = supabaseAdmin
      .from("cluster4_line_targets")
      .select(TARGET_WITH_LINE_SELECT)
      .in("week_id", weekIds)
      .eq("cluster4_lines.is_active", true);
    // QA 라인 분리(2026-07-06): 운영 조회(QA_HIDE_REAL_USERS=false)에서는 QA 테스트 라인 제외.
    //   QA 조회(true)에서는 필터 미적용 → 운영+QA 라인 모두 노출(사용자 확정). 강화율 SoT 통일 이후
    //   라인 렌더가 카드/성장 공통 소스이므로 이 한 곳(+info) 필터가 두 경로 모두에 반영된다.
    if (!QA_HIDE_REAL_USERS) q = q.eq("cluster4_lines.is_qa_test", false);
    return q
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as Promise<{
      data: TargetWithLineRow[] | null;
      error: { message: string } | null;
    }>;
  });
}

// 그 주차의 활성 실무 정보(info) 라인을 cluster4_lines 에서 직접 전수 수집한다(타깃 무관).
//   ⚠ 정책(2026-06-09 per-activity 모델): 실무 정보 라인은 대상 크루가 0명이어도 "개설"이며,
//     org-visible 이면 미배정 크루에게 "강화 실패(내용 노출)"로 보여야 한다. 그러나 openedByWeek 는
//     cluster4_line_targets(targetRows) 기반이라 타깃이 1건도 없는 info 라인(예: 위즈덤/캘린더 0명
//     개설)을 누락한다. 여기서 라인행 자체를 개설 신호로 보강해 그 누락을 메운다.
//   cluster4_line_targets 에 sentinel 을 쓰지 않는다(데이터 무변경 — 조회 시점 로직 보강).
//   info 만 대상(experience/competency/career 는 슬롯/보이드/패딩 등 별도 정책 — 타깃 기반 유지).
//   안정 정렬(created_at desc, id desc)로 페이지 경계 안전. openedByWeek 는 line.id 단위 dedup 이라
//   targetRows 와 겹치는 라인(타깃 보유 info)은 자연히 1회만 반영된다.
async function fetchActiveInfoLinesByWeek(weekIds: string[]): Promise<InfoLineRow[]> {
  if (weekIds.length === 0) return [];
  return collectAllRows<InfoLineRow>((from, to) => {
    let q = supabaseAdmin
      .from("cluster4_lines")
      .select(LINE_ROW_SELECT)
      .eq("part_type", "info")
      .eq("is_active", true)
      .in("week_id", weekIds);
    // QA 라인 분리(2026-07-06): 운영 조회에서 QA 테스트 info 라인 제외(QA 조회는 전부 노출).
    if (!QA_HIDE_REAL_USERS) q = q.eq("is_qa_test", false);
    return q
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as Promise<{
      data: InfoLineRow[] | null;
      error: { message: string } | null;
    }>;
  });
}

async function fetchLineDetailsByWeek(
  profileUserId: string,
  weekIds: string[],
  restWeekIds: Set<string>,
  // v11 "필수 슬롯 fail" 적용 주차 (buildSlotFailWeekIds). 미포함 주차의 필수 슬롯 placeholder 는
  // fail 이 아니라 해당 없음(not_opened) — 진행/집계 중 fail 선반영 금지 + 실사용자 과거 보존.
  slotFailWeekIds: Set<string>,
  // 관리(5) 슬롯 개방 여부(membership_level 심화/운영진) — 잠금 사용자는 관리 슬롯 라인을
  // 분모 A/fail 칸에서 제외(해당 없음)해 고객앱 슬롯 잠금(카드 미노출)과 "총 N개"를 일치시킨다.
  managementSlotOpen: boolean,
  // 확정(공표) 주차 — resultStatus가 success/fail 로 판정 완료된 주차(result_published_at 반영).
  // v14.1: 확정 주차의 competency 0라인 placeholder 는 "강화 대기"가 아니라 "강화 실패"
  // (대기는 미확정 running/tallying 주차에서만 가능). 미전달(기본 빈 셋)이면 기존 v14 동작.
  confirmedWeekIds: Set<string> = new Set(),
  // 레거시(허브 도입 전, start_date < 2026 여름 W1) 주차 — 통합 라인 단일 렌더 게이트.
  //   실무 경험: [통합] 주차 활동 내역 라인(마스터 매칭)만 렌더. 그 외 본인 배정/개설 라인 제외.
  //   실무 정보/역량/경력: 라인 없음 — slot placeholder(2.5)/career 패딩(2.6)/competency fold(2.7)
  //   전부 미적용 → step 3 not_applicable placeholder 만 남는다(빈 허브).
  legacyWeekIds: Set<string> = new Set(),
): Promise<Map<string, Cluster4LineDetailDto[]>> {
  const result = new Map<string, Cluster4LineDetailDto[]>();
  if (weekIds.length === 0) return result;

  // 레거시 통합 마스터 id — 레거시 주차 렌더 필터 기준. 미생성(null)이면 레거시 주차는
  // 통합 라인 없이 빈 허브로 렌더된다(fail-closed).
  // 통합 마스터 id — 레거시 주차 렌더 필터(legacyWeekIds) + 여름(비레거시) 주차 통합 제외
  //   양쪽에서 쓰므로 항상 조회한다(여름 시뮬은 legacyWeekIds 가 비어도 통합 라인을 식별해야 함).
  const unifiedMasterId = await fetchLegacyUnifiedMasterId();
  const isLegacyUnifiedLine = (
    line: NonNullable<TargetWithLineRow["cluster4_lines"]> | null | undefined,
  ): boolean =>
    Boolean(
      line &&
        line.part_type === "experience" &&
        unifiedMasterId &&
        line.experience_line_master_id === unifiedMasterId,
    );

  // 전수 페이지네이션으로 받는다(위 fetchAllLineTargetsByWeek 주석 참고). 기본 1000행 cap 에
  // 걸리면 openedByWeek(개설 신호)·본인 real DTO·canEdit 가 누락되고, 헤더 분모 A
  // (growth 경로 fetchWeeksWithOpenLinesByPart)와 어긋나 "총 N개 중 …인데 칸은 N-1개"가 발생한다.
  // 완전 집합 위에서 계산하면 두 경로가 동일 opened-line 집합을 공유해 정합이 보장된다(요구 2·3).
  const [targetRows, editWindowByPart, userOrg, userTeamRole, activeInfoLines] =
    await Promise.all([
      fetchAllLineTargetsByWeek(weekIds),
      fetchHubEditWindows(profileUserId),
      fetchUserOrganizationSlug(profileUserId),
      fetchUserTeamAndRole(profileUserId),
      // 타깃 0건 포함 활성 info 라인(개설 신호 보강용 — per-activity 모델).
      fetchActiveInfoLinesByWeek(weekIds),
    ]);
  const relevantTargets = targetRows.filter(
    (row) => row.target_mode === "user" && row.target_user_id === profileUserId,
  );
  const targetIds = relevantTargets.map((row) => row.id);

  const submissionsByTargetId = new Map<string, SubmissionRow>();
  if (targetIds.length > 0) {
    const { data: submissionData, error: submissionError } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("id,line_target_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images,submitted_at,updated_at")
      .eq("user_id", profileUserId)
      .in("line_target_id", targetIds);

    if (submissionError) {
      throw new Cluster4WeeklyCardsError(500, submissionError.message);
    }

    for (const row of (submissionData ?? []) as SubmissionRow[]) {
      submissionsByTargetId.set(row.line_target_id, row);
    }
  }

  // 실무 경험 평점(cluster4_experience_line_evaluations.rating) 일괄 룩업.
  // experience part target 에 한해 (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑.
  // 조회 실패해도 카드 전체를 깨뜨리지 않고 평점만 null 폴백한다.
  const experienceTargetIds = relevantTargets
    .filter((row) => row.cluster4_lines?.part_type === "experience")
    .map((row) => row.id);
  const experienceRatingByTargetId = new Map<string, number>();
  if (experienceTargetIds.length > 0) {
    const { data: evalData, error: evalError } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,rating")
      .eq("user_id", profileUserId)
      .in("line_target_id", experienceTargetIds);
    if (evalError) {
      console.warn("[cluster4/weekly-cards] experience evaluations lookup failed", {
        message: evalError.message,
      });
    } else {
      for (const row of (evalData ?? []) as {
        line_target_id: string;
        rating: number;
      }[]) {
        experienceRatingByTargetId.set(row.line_target_id, row.rating);
      }
    }
  }

  // 실무 경력 평점(cluster4_career_line_evaluations.grade / grade_points) 일괄 룩업.
  // career part target 에 한해 (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑.
  // 조회 실패해도 카드 전체를 깨뜨리지 않고 평점만 null 폴백(→ unevaluated)한다.
  const careerTargetIds = relevantTargets
    .filter((row) => row.cluster4_lines?.part_type === "career")
    .map((row) => row.id);
  const careerGradeByTargetId = new Map<string, CareerGradeEval>();
  if (careerTargetIds.length > 0) {
    const { data: careerEvalData, error: careerEvalError } = await supabaseAdmin
      .from("cluster4_career_line_evaluations")
      .select("line_target_id,grade,grade_points")
      .eq("user_id", profileUserId)
      .in("line_target_id", careerTargetIds);
    if (careerEvalError) {
      console.warn("[cluster4/weekly-cards] career evaluations lookup failed", {
        message: careerEvalError.message,
      });
    } else {
      for (const row of (careerEvalData ?? []) as {
        line_target_id: string;
        grade: CareerGrade;
        grade_points: number;
      }[]) {
        careerGradeByTargetId.set(row.line_target_id, {
          grade: row.grade,
          points: row.grade_points,
        });
      }
    }
  }

  // information sub-line 라벨 (activity_types.name) 일괄 룩업.
  // 본인 미배정 fail 라인도 content(activityTypeName)를 노출하므로 targetRows(전 유저) 기준으로 넓힌다.
  const activityTypeIds = Array.from(
    new Set(
      [
        ...targetRows.map((row) => row.cluster4_lines?.activity_type_id),
        // 타깃 0건 info 라인의 activityType 도 라벨/표시코드(IFBS-NN000X) 룩업 대상에 포함.
        ...activeInfoLines.map((line) => line.activity_type_id),
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const activityTypeNameById =
    await fetchActivityTypeNamesByIds(activityTypeIds);
  // info 라인 고객 표시 코드(IFBS-NN000X) — /admin/lines/info(line_registrations) SoT.
  const infoDisplayCodeByActivityTypeId =
    await fetchInfoDisplayCodeByActivityTypeIds(activityTypeIds, activityTypeNameById);

  // experience sub-line 5슬롯 분류 (experience_line_master_id → {category, slotOrder}) 일괄 룩업.
  // 미배정 fail 라인의 카테고리/슬롯도 노출하므로 targetRows(전 유저) 기준으로 넓힌다.
  const experienceMasterIds = Array.from(
    new Set(
      targetRows
        .filter((row) => row.cluster4_lines?.part_type === "experience")
        .map((row) => row.cluster4_lines?.experience_line_master_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const experienceMasterMetaById =
    await fetchExperienceMasterMetaByIds(experienceMasterIds);

  // competency sub-line 라인명 (competency_line_master_id → line_name) 일괄 룩업.
  // 미배정 competency 도 이제 개설 라인 content(lineName 포함)를 노출하므로
  // (openedCompetencyFailLineDetail), experience/career 와 동일하게 targetRows(전 유저) 기준으로
  // 넓혀 본인 미배정 라인의 master line_name 까지 매핑한다.
  const competencyMasterIds = Array.from(
    new Set(
      targetRows
        .filter((row) => row.cluster4_lines?.part_type === "competency")
        .map((row) => row.cluster4_lines?.competency_line_master_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const competencyMasterMetaById =
    await fetchCompetencyMasterMetaByIds(competencyMasterIds);

  // 그 주차에 개설된(=any target 존재) distinct 라인(대표 content) 수집 — 본인 미배정 라인 표시용.
  // week_id → line_id → {dbPart, line content}. targetRows 는 active 라인 inner-join 이므로 비활성 제외.
  const openedByWeek = new Map<
    string,
    Map<string, { dbPart: DbLinePartType; line: NonNullable<TargetWithLineRow["cluster4_lines"]> }>
  >();
  for (const row of targetRows) {
    const line = row.cluster4_lines;
    if (!line) continue;
    let m = openedByWeek.get(row.week_id);
    if (!m) {
      m = new Map();
      openedByWeek.set(row.week_id, m);
    }
    if (!m.has(line.id)) m.set(line.id, { dbPart: line.part_type, line });
  }
  // 타깃 0건 info 라인 보강 — 라인행 자체를 그 라인 week_id 의 개설 신호로 추가한다.
  //   line.id 단위 dedup 이라 타깃 보유 info 라인(이미 위에서 추가됨)은 중복되지 않는다.
  //   Step 2 에서 org 필터(isLineVisibleForUserOrg)·본인 배정 제외가 그대로 적용된다.
  for (const line of activeInfoLines) {
    if (!line.week_id) continue;
    let m = openedByWeek.get(line.week_id);
    if (!m) {
      m = new Map();
      openedByWeek.set(line.week_id, m);
    }
    if (!m.has(line.id)) m.set(line.id, { dbPart: line.part_type, line });
  }

  // career sub-line sponsor-card 메타 (career_project_id → 회사/감독자) 일괄 룩업.
  // 미배정 개설 career 라인도 sponsor 메타를 노출(synthetic fail)하므로 targetRows(전 유저)
  // 기준으로 넓힌다 — experience/activityType 룩업과 동일 정책.
  const careerProjectIds = Array.from(
    new Set(
      targetRows
        .filter((row) => row.cluster4_lines?.part_type === "career")
        .map((row) => row.cluster4_lines?.career_project_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const careerProjectMetaById =
    await fetchCareerProjectMetaByIds(careerProjectIds);

  // 라인 org 노출 판정 맵 (lineId → org SoT). 본인 배정(Step 1)·미배정(Step 2) 양쪽 필터 공통.
  // 동시에 line_code 프리픽스(보조값)와 마스터 org(SoT) 불일치를 진단 로그로 남긴다(판정엔 미사용).
  const lineOrgById = new Map<string, LineOrgScope | null>();
  for (const row of targetRows) {
    const line = row.cluster4_lines;
    if (!line || lineOrgById.has(line.id)) continue;
    const org = resolveLineOrg(
      line,
      experienceMasterMetaById,
      competencyMasterMetaById,
      careerProjectMetaById,
    );
    lineOrgById.set(line.id, org);
    // 진단(판정엔 미사용 — line_code 가 우선): line_code 가 "특정 조직"(EC/OK/PX)을 가리키는데 마스터
    //   org 가 다른 "특정 조직"이면 데이터 불일치 경고(노출은 line_code 우선으로 처리됨). codeOrg==='common'
    //   (BS) 은 정책상 master 를 덮어 common 으로 가는 의도된 동작이라 노이즈 제거 차 제외한다.
    const codeOrg = parseLineCodeOrg(line.line_code);
    const masterOrg = resolveMasterOrg(
      line,
      experienceMasterMetaById,
      competencyMasterMetaById,
      careerProjectMetaById,
    );
    if (
      codeOrg &&
      codeOrg !== "common" &&
      masterOrg &&
      masterOrg !== "common" &&
      codeOrg !== masterOrg
    ) {
      console.warn("[cluster4/weekly-cards] line org disagreement (line_code wins)", {
        lineId: line.id,
        partType: line.part_type,
        lineCode: line.line_code,
        lineCodeOrg: codeOrg,
        masterOrg,
        applied: codeOrg,
      });
    }
  }
  // 타깃 0건 info 라인의 org 판정도 채운다(Step 2 org 필터 isLineVisibleForUserOrg 에서 사용).
  //   info 는 line_code 토큰(EC/OK/PX/BS)으로 org 가 결정되므로 master 메타와 무관하다.
  for (const line of activeInfoLines) {
    if (lineOrgById.has(line.id)) continue;
    lineOrgById.set(
      line.id,
      resolveLineOrg(
        line,
        experienceMasterMetaById,
        competencyMasterMetaById,
        careerProjectMetaById,
      ),
    );
  }

  const now = Date.now();
  for (const weekId of weekIds) {
    // 같은 주차의 user-mode target 만 카드에 매핑한다. 다른 주차의 target 은 절대
    // 현재 주차 카드에 영향을 주지 않는다 (weekly-cards 의 canEdit 매칭 단위는
    // weekId + lineTargetId).
    const weekTargets = relevantTargets.filter((row) => row.week_id === weekId);
    const lines: Cluster4LineDetailDto[] = [];
    const partsPresent = new Set<Cluster4LinePartType>();
    const userTargetedLineIds = new Set<string>();
    // 레거시(허브 도입 전) 주차 — 기본은 통합 라인만 렌더.
    const isLegacyWeek = legacyWeekIds.has(weekId);
    // Phase 3(2026-07-06): 레거시 주차에 granular(비통합) 실무경험 라인이 있으면 그 주차의 경험 허브는
    //   여름 규칙으로 렌더한다 — [통합] 대신 granular 경험 표시 + 5슬롯 placeholder. granular 이 없으면
    //   기존 레거시 [통합] 단일 유지(무변경). 실사용자 레거시 주차엔 granular 부재라 항상 false →
    //   과거 강화율 불변. QA/테스트 백필 경험 라인만 표시된다. (역량은 아래 별도 게이트로 항상 허용.)
    const hasGranularExperience =
      isLegacyWeek &&
      (weekTargets.some((t) => {
        const l = t.cluster4_lines;
        return !!l && l.part_type === "experience" && !isLegacyUnifiedLine(l);
      }) ||
        (() => {
          const opened = openedByWeek.get(weekId);
          return opened
            ? [...opened.values()].some(
                ({ line }) =>
                  line.part_type === "experience" && !isLegacyUnifiedLine(line),
              )
            : false;
        })());
    // 경험 허브의 "여름처럼 렌더" 여부 — 비레거시이거나(항상) granular 보유 레거시.
    const experienceAsSummer = !isLegacyWeek || hasGranularExperience;

    // 1. 본인 배정 라인 (real DTO).
    for (const target of weekTargets) {
      // 레거시 주차(허브 도입 전) 정책 (2026-06-08 개정 — 추가 개설 라인 집계 반영):
      //   - 실무 경험 허브: 통합 라인만 대표로 렌더/집계한다(기존 정책 불변). 비통합 experience
      //     라인은 숨겨 "통합 라인이 그 주차 경험을 대표"하는 모델을 지킨다(통합 라인 대체 금지).
      //   - 실무 정보/역량/경력 허브: 관리자가 추가 개설·배정한 비통합 라인을 정상 렌더하고,
      //     그 라인의 "제출 성공/실패"를 강화율(breakdownFromLines 분모/분자)에 반영한다.
      //     ⚠ 강화율 반영 기준은 제출(submission) 기반이다 — 레거시 추가 라인은 enhancementStatus 를
      //     base.status(=제출 있으면 success, 마감 후 미제출이면 fail, 마감 전이면 pending)로 덮어
      //     "미제출=강화 실패"가 분모에 들어가게 한다. (신규 주차의 공용 enhancement 규칙
      //     [타깃+마감=success]은 건드리지 않는다 — 레거시 분기 한정.)
      //   - 주차 최종 verdict(userWeekStatus=card.resultStatus)는 통합 라인 기준으로 별도 산정되어
      //     lines 와 무관 → 추가 라인을 집계해도 주차 판정은 불변(강화율↔verdict 디커플).
      const legacyAdditive =
        isLegacyWeek && !isLegacyUnifiedLine(target.cluster4_lines);
      if (
        legacyAdditive &&
        target.cluster4_lines?.part_type === "experience" &&
        !hasGranularExperience
      ) {
        // 레거시 + granular 경험 없음 → 통합 라인만 대표(비통합 경험 숨김). granular 있으면 표시(Phase 3).
        continue;
      }
      // [통합] 라인 제외: 여름(비레거시) 또는 granular 경험 보유 레거시 주차(Phase 3 — 통합 대체).
      //   granular 없는 레거시 주차(experienceAsSummer=false)는 통합이 정당한 단일 대표 라인이라 유지(불변).
      if (experienceAsSummer && isLegacyUnifiedLine(target.cluster4_lines)) {
        continue;
      }
      // org 노출 필터: 다른 조직 라인이면 본인 배정이라도 제외(요구 6).
      //   미배정으로 강등되는 것이 아니라 아예 누락 → Step 3 가 not_applicable placeholder 로 채운다.
      //   allowUnknown=true: 본인에게 실제 배정된 라인은 org 판정 불가여도 노출 허용(Step 1 예외).
      const targetLine = target.cluster4_lines;
      if (
        targetLine &&
        !isLineVisibleForUserOrg(lineOrgById.get(targetLine.id) ?? null, userOrg, {
          allowUnknown: true,
        })
      ) {
        continue;
      }
      const base = toLineDetail(
        target,
        submissionsByTargetId.get(target.id) ?? null,
        activityTypeNameById,
        experienceRatingByTargetId,
        experienceMasterMetaById,
        careerGradeByTargetId,
        careerProjectMetaById,
        competencyMasterMetaById,
        infoDisplayCodeByActivityTypeId,
      );
      if (!base) continue;
      if (target.cluster4_lines) userTargetedLineIds.add(target.cluster4_lines.id);
      // 슬롯 미상(experience master 미연결) 라인 fail-closed (2026-06-04 v13):
      // 고객앱 실무 경험 UI 는 고정 5슬롯(experienceSlotOrder 1~5)에만 카드를 놓는다 — 슬롯 미상
      // 라인은 본인 배정이어도 화면 어디에도 렌더되지 않으면서 분모 A 에만 들어가 "총 N개 > 표시
      // 칸"이 된다(예: EX02A 레거시 라인). org 판정불가 fail-closed 와 동일 원칙으로 칸/분모에서
      // 제외하고 warn 만 남긴다 — 근본 해결은 라인의 master 연결(데이터 정비).
      if (base.partType === "experience" && base.experienceSlotOrder == null) {
        console.warn(
          "[cluster4/weekly-cards] 슬롯 미상(master 미연결) experience 라인 제외 — master 연결 필요",
          { profileUserId, weekId, lineId: base.lineId, lineCode: base.lineCode },
        );
        continue;
      }
      const dbPartType = target.cluster4_lines?.part_type;
      // evaluateCluster4HubEdit 는 단일 line target 단위로 ownership / window 를 평가.
      // editWindow override 가 OPEN 이면 마감된 line target 의 canEdit 만 ok_override 로 우회된다.
      // override 는 (이 카드 주차 행 OR 전역 행) 중 active 한 것을 채택한다(additive OR).
      const decision = evaluateCluster4HubEdit({
        target: toPermissionTarget(target),
        editWindow: dbPartType
          ? resolveHubEditWindow(editWindowByPart.get(dbPartType), weekId, now)
          : null,
        profileUserId,
        now,
      });
      const legacySubmissionBasedEnhancement =
        legacyAdditive &&
        dbPartType !== "competency" &&
        dbPartType !== "info";
      lines.push({
        ...base,
        // 레거시 추가 라인(career)은 제출 기반으로 강화율에 반영한다:
        //   enhancementStatus := base.status (success/fail/pending). status="void" 는 타깃 보유
        //   라인에서는 발생하지 않으나 타입 안전상 not_applicable 로 폴백한다.
        //   통합 라인·신규 주차(legacyAdditive=false)는 공용 enhancement 규칙을 그대로 유지(불변).
        //   competency 는 관리자 개설 target 자체가 성공 SoT 이므로 submission 기반 override 에서 제외한다.
        //   info(실무 정보)도 동일 — 대상자 배정 자체가 강화 SoT 다(2026-06-21, computeCluster4Enhancement
        //     문서 정책 "배정+마감 후=success, 제출 무관"과 정합). 레거시/비레거시 주차가 갈라지지 않게
        //     레거시 override 에서 info 를 제외한다. 미기입은 submissionStatus(not_submitted)로만 표시되고
        //     강화 실패 사유가 아니다. (미배정 크루의 synthetic fail = Step 2 는 불변 — 개설+미배정=fail.)
        ...(legacySubmissionBasedEnhancement
          ? {
              enhancementStatus:
                base.status === "void"
                  ? ("not_applicable" as const)
                  : base.status,
            }
          : null),
        canEdit: decision.canEdit,
        editReason: decisionReasonToDto(decision.reason),
      });
      partsPresent.add(base.partType);
    }

    // 2. 개설됐지만 본인 미배정인 라인 (개설 신호=라인행 기준).
    //   info/experience → synthetic fail (강화율 분모 A 의 fail 과 1:1). 개설 라인 content 를 담은
    //                     fail DTO(보이드 아님 — 정책상 내용 노출).
    //   career          → not_applicable("해당 없음") 유지하되 개설 라인 content 노출(2026-06-02
    //                     career 정책 개정). status=void / enhancementStatus=not_applicable 이면서도
    //                     mainTitle/outputLinks/outputImages/projectCode/companyName 등은 채운다.
    //   competency      → fail + 개설 라인 content 노출(읽기 전용). 2026-06-02 재개정으로 보이드
    //                     (emptyLine, 메타 null) 폐기 — info/experience 와 동일하게 lineName/lineCode/
    //                     mainTitle/output_* 을 채워 "왜 미배정 실패인지" 보이게 한다. 수정은 canEdit=false.
    //   휴식/전환 주차(restWeekIds)는 평가/집계 제외 → synthetic 라인 미적용(아래 not_applicable).
    const restWeek = restWeekIds.has(weekId);
    if (!restWeek) {
      const weekOpened = openedByWeek.get(weekId);
      if (weekOpened) {
        for (const { dbPart, line } of weekOpened.values()) {
          if (userTargetedLineIds.has(line.id)) continue; // 본인 배정 → 1단계 real DTO 가 처리
          // 레거시 주차: 통합(experience) 라인 외 개설 라인은 synthetic fail/content 노출 대상이 아니다.
          //   통합 라인만 "개설 + 본인 미배정 = 강화 실패(content 노출)"로 내려간다.
          //   ⚠ 예외(2026-06-09 정책): 실무 정보(information)는 per-activity 모델을 항상 따른다 —
          //     라인 개설이 되면(0명 개설 포함) 레거시 주차에서도 미배정 크루 = 강화 실패로 노출한다.
          //     (info 는 통합 라인이 아니므로 legacy unified 모델 대상이 아니다. 라인 개설 자체가
          //      없으면 그대로 not_applicable(Step 3). 주차 verdict 는 통합 라인 기준 디커플 — 불변.)
          //   Phase 3(2026-07-06): 레거시에서도 역량(competency)은 항상, 경험(experience)은 granular 보유
          //   주차에 한해 개설 신호(미배정 fail/content 노출)를 허용한다. career 등은 기존대로 차단.
          if (
            isLegacyWeek &&
            !isLegacyUnifiedLine(line) &&
            toPublicPart(dbPart) !== "information" &&
            toPublicPart(dbPart) !== "competency" &&
            !(toPublicPart(dbPart) === "experience" && hasGranularExperience)
          )
            continue;
          // org 노출 필터(핵심 수정 — EC 라인이 PHALANX 에 누수되던 지점). 다른 조직 + org 판정
          //   불가 라인 모두 차단(fail-closed). allowUnknown 기본 false → 미배정 unknown 라인은 숨김.
          if (!isLineVisibleForUserOrg(lineOrgById.get(line.id) ?? null, userOrg)) {
            continue;
          }
          const publicPart = toPublicPart(dbPart);
          if (publicPart === "competency") {
            // 개설됨 + 본인 미배정 → fail + 개설 라인 content 노출(읽기 전용). emptyLine(보이드) 폐기.
            lines.push(
              openedCompetencyFailLineDetail(line, weekId, competencyMasterMetaById),
            );
          } else if (publicPart === "career") {
            // career 미선발 = not_applicable 유지 + 개설 라인 content 노출.
            lines.push(openedCareerLineDetail(line, weekId, careerProjectMetaById));
          } else {
            // 관리(5) 슬롯 잠금 사용자: 관리 슬롯 개설-미배정 라인은 synthetic fail 로 넣지 않는다.
            // 고객앱이 관리 슬롯 카드를 잠금(미노출)하므로 분모 A 에 들어가면 "총 N개 > 표시 칸"
            // 불일치가 난다(예: T최수빈 봄 12주차 — 표시 1칸 · 총 2개). 칸은 2.5 단계 placeholder
            // (해당 없음)가 채운다.
            if (publicPart === "experience") {
              const slotOrder = line.experience_line_master_id
                ? experienceMasterMetaById.get(line.experience_line_master_id)?.slotOrder ?? null
                : null;
              // 슬롯 미상(master 미연결) — 5슬롯 UI 에 렌더 불가 → fail-closed 제외 (step 1 과 동일 원칙).
              if (slotOrder == null) {
                console.warn(
                  "[cluster4/weekly-cards] 슬롯 미상(master 미연결) 개설 experience 라인 제외 — master 연결 필요",
                  { profileUserId, weekId, lineId: line.id, lineCode: line.line_code },
                );
                continue;
              }
              if (!managementSlotOpen && slotOrder === EXPERIENCE_MANAGEMENT_SLOT_ORDER) {
                continue;
              }
              // ── 여름(비레거시) 또는 granular 경험 레거시 주차: synthetic fail 팀/역할 스코프 ──
              //   granular 없는 레거시 주차는 여기 진입 전 차단(experienceAsSummer=false).
              if (experienceAsSummer) {
                // 타팀 라인 제외: 본인 팀에 개설된 experience 라인만 분모 대상(타팀/공용 누수 차단).
                //   teamId 미해석 시 필터 미적용(fail-open).
                if (userTeamRole.teamId && line.team_id !== userTeamRole.teamId) {
                  continue;
                }
                // 타역할 관리(5) 라인 제외: 본인 역할 라인만(_파트장→파트장 / _에이전트→에이전트).
                if (slotOrder === EXPERIENCE_MANAGEMENT_SLOT_ORDER) {
                  const code = line.line_code ?? "";
                  if (code.endsWith("EL0001") && !userTeamRole.isPartLeader) continue;
                  if (code.endsWith("EL0002") && !userTeamRole.isAgent) continue;
                }
              }
            }
            lines.push(
              openedFailLineDetail(
                line,
                weekId,
                publicPart,
                activityTypeNameById,
                experienceMasterMetaById,
                infoDisplayCodeByActivityTypeId,
              ),
            );
          }
          partsPresent.add(publicPart);
        }
      }
    }

    // 2.5 실무 경험 슬롯 placeholder (2026-06-04 슬롯 정책 + 적용 시점 분리).
    //   지금까지 모인 experience 칸(본인 배정 + 개설 미배정)의 슬롯 집합을 보고:
    //     - 필수 슬롯(1·2·3·5)이 비어 있으면 → 신정책 적용 주차(slotFailWeekIds: 판정 완료 +
    //       테스트 전 주차/실사용자 EFFECTIVE_FROM 이후)는 강화 실패 placeholder, 그 외
    //       (진행/집계 중 fail 선반영 금지·휴식/전환·실사용자 과거 보존)는 해당 없음.
    //     - 확장 슬롯(4)이 비어 있으면 → 해당 없음 placeholder (정해진 주차에만 열림).
    //   org 필터로 숨겨진 라인 칸도 "이 사용자에게 없는 칸"이므로 placeholder 가 자리를 채운다.
    // 레거시(허브 도입 전) 주차: 기본은 5슬롯(2.5)/career 패딩(2.6)/competency fold(2.7) 미적용 —
    //   통합 라인 1개(+step 3 na)만. Phase 3(2026-07-06): granular 경험 보유 레거시 주차는 2.5 적용,
    //   역량은 라인 실제 보유 시에만 2.7 fold 적용(합성 금지). career 패딩(2.6)은 레거시 불변.
    if (experienceAsSummer) {
    const experienceSlotsPresent = new Set<number>();
    for (const l of lines) {
      if (l.partType === "experience" && l.experienceSlotOrder != null) {
        experienceSlotsPresent.add(l.experienceSlotOrder);
      }
    }
    for (const slot of EXPERIENCE_ALWAYS_OPEN_SLOT_ORDERS) {
      if (!experienceSlotsPresent.has(slot)) {
        // 관리(5) 슬롯은 잠금 사용자(membership_level 일반/미확정)에게 "항상-개설 fail" 미적용 —
        // 고객앱이 슬롯 자체를 잠가 카드를 노출하지 않으므로 해당 없음(분모 제외)으로 내린다.
        const managementLocked =
          slot === EXPERIENCE_MANAGEMENT_SLOT_ORDER && !managementSlotOpen;
        lines.push(
          experienceSlotPlaceholderLine(
            weekId,
            slot,
            !managementLocked && slotFailWeekIds.has(weekId)
              ? "required_fail"
              : "not_opened",
          ),
        );
      }
    }
    if (!experienceSlotsPresent.has(4)) {
      lines.push(experienceSlotPlaceholderLine(weekId, 4, "not_opened"));
    }
    // 데이터 이상 신호: 잠금 사용자에게 관리(5) 슬롯 라인이 직접 배정돼 있으면(본인 타깃 보유)
    // 칸은 분모에 들어가지만 고객앱은 슬롯을 잠가 카드를 숨긴다 → "총 N개" 불일치 재발 후보.
    // 실데이터를 임의로 가리지 않고(배정 = 운영자 의도) 경고만 남긴다 — membership_level 정비 대상.
    if (
      !managementSlotOpen &&
      lines.some(
        (l) =>
          l.partType === "experience" &&
          l.experienceSlotOrder === EXPERIENCE_MANAGEMENT_SLOT_ORDER &&
          l.lineTargetId != null,
      )
    ) {
      console.warn(
        "[cluster4/weekly-cards] 관리 슬롯 잠금 사용자에게 관리 라인 직접 배정 감지 — membership_level 확인 필요",
        { profileUserId, weekId },
      );
    }
    partsPresent.add("experience");
    } // experienceAsSummer (2.5 게이트 끝)

    // 2.6 실무 경력 6칸 패딩 (2026-06-04 정책: 항상 6개 칸 표시) — 여름만(레거시 불변).
    //   개설/선발/미선발(content 노출)로 채워지지 않은 나머지 칸은 보이드
    //   (status="void", enhancementStatus=not_applicable → 분모 제외).
    if (!isLegacyWeek) {
    const careerCount = lines.reduce(
      (n, l) => (l.partType === "career" ? n + 1 : n),
      0,
    );
    for (let i = careerCount; i < CAREER_DISPLAY_CAP; i++) {
      lines.push(emptyLine("career", weekId, false));
    }
    partsPresent.add("career");
    } // !isLegacyWeek (2.6 게이트 끝)

    // 2.7 실무 역량 단일 정규화 (2026-06-04 v14): 역량은 1인·1주차 항상 정확히 1칸.
    //   - 라인 N개(개설/배정 무관) → 대표 1개로 fold: success > pending > fail 우선.
    //   - 여름: 라인 0개면 placeholder(미확정=대기/확정=실패). growth abilityNormalized 와 동일.
    //   - Phase 3(2026-07-06) 레거시: 역량 라인이 실제 있을 때만 fold(1칸) — 없으면 합성 placeholder
    //     금지(step 3 na). 실사용자 레거시 주차엔 역량 라인 부재라 무변경(과거 강화율 불변).
    //   - 휴식/전환 주차(restWeek)는 기존 na placeholder 유지(분모 제외) — step 3 에서 채움.
    if (!restWeek) {
      const compLines = lines.filter((l) => l.partType === "competency");
      if (!isLegacyWeek || compLines.length > 0) {
      const fold =
        compLines.find((l) => l.enhancementStatus === "success") ??
        compLines.find((l) => l.enhancementStatus === "pending") ??
        compLines.find((l) => l.enhancementStatus === "fail") ??
        null;
      if (compLines.length !== 1 || !fold) {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].partType === "competency") lines.splice(i, 1);
        }
        lines.push(
          fold ??
            (confirmedWeekIds.has(weekId)
              ? competencyFailPlaceholderLine(weekId)
              : competencyPendingPlaceholderLine(weekId)),
        );
      } else if (fold !== compLines[0]) {
        // 단일 라인이지만 대표가 아닌 경우는 구조상 없음(방어) — fold 만 남긴다.
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].partType === "competency" && lines[i] !== fold) lines.splice(i, 1);
        }
      }
      partsPresent.add("competency");
      } // 레거시=역량 라인 보유 시에만 fold(합성 금지)
    }

    // 3. 라인이 전혀 없는 part → not_applicable placeholder (UI 완결성; 미개설·휴식주차).
    //   (experience/career 는 2.5/2.6 에서 항상 채워지므로 사실상 info/competency 전용.)
    //   lineTargetId 없음 → canEdit=false / editReason="target_missing" 고정.
    for (const partType of PUBLIC_PARTS) {
      if (!partsPresent.has(partType)) {
        lines.push(emptyLine(partType, weekId, false));
      }
    }

    result.set(weekId, lines);
  }

  return result;
}

// ── section1-header 보강용 사용자 단위 스냅샷 ──
// user_team_parts 의 (joined_at, left_at) 윈도 안에 카드의 week_start_date 가 들어가는 row 1건을
// 선택하고, 같은 row 의 generation + (managed_team_id → teams.name) 을 카드별로 노출한다.
// onboardingWeekId 는 user_profiles.onboarding_week_id 그대로 — 카드별 weekId 비교 1회.
type UserTeamPartRow = {
  generation: number | null;
  joined_at: string;
  left_at: string | null;
  managed_team_id: string | null;
};

type HeaderExtrasSnapshot = {
  teamParts: UserTeamPartRow[];
  managedTeamNameById: Map<string, string>;
  onboardingWeekId: string | null;
};

async function fetchHeaderExtrasSnapshot(
  profileUserId: string,
): Promise<HeaderExtrasSnapshot> {
  // 카드 보강용 보조 데이터 — 실패해도 weekly-cards 본 흐름을 깨뜨리지 않는다 (null/empty 폴백).
  const [teamPartsRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from("user_team_parts")
      .select("generation,joined_at,left_at,managed_team_id")
      .eq("user_id", profileUserId),
    supabaseAdmin
      .from("user_profiles")
      .select("onboarding_week_id")
      .eq("user_id", profileUserId)
      .maybeSingle(),
  ]);

  if (teamPartsRes.error) {
    console.warn("[cluster4/weekly-cards] user_team_parts lookup failed", {
      message: teamPartsRes.error.message,
    });
  }
  if (profileRes.error) {
    console.warn("[cluster4/weekly-cards] user_profiles lookup failed", {
      message: profileRes.error.message,
    });
  }

  const teamParts = ((teamPartsRes.data ?? []) as UserTeamPartRow[]).filter(
    (row) => Boolean(row.joined_at),
  );

  const managedTeamIds = Array.from(
    new Set(
      teamParts
        .map((row) => row.managed_team_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const managedTeamNameById = new Map<string, string>();
  if (managedTeamIds.length > 0) {
    const { data: teamsData, error: teamsError } = await supabaseAdmin
      .from("teams")
      .select("id,name")
      .in("id", managedTeamIds);
    if (teamsError) {
      console.warn("[cluster4/weekly-cards] teams lookup failed", {
        message: teamsError.message,
      });
    } else if (teamsData) {
      for (const row of teamsData as { id: string; name: string | null }[]) {
        if (row.id && row.name) managedTeamNameById.set(row.id, row.name);
      }
    }
  }

  const onboardingWeekId =
    (profileRes.data as { onboarding_week_id: string | null } | null)
      ?.onboarding_week_id ?? null;

  return { teamParts, managedTeamNameById, onboardingWeekId };
}

function resolveHeaderExtras(
  card: WeeklyCardDto,
  snapshot: HeaderExtrasSnapshot,
): HeaderExtras {
  // joined_at <= weekStart 이고 (left_at IS NULL OR left_at > weekStart) 인 row.
  // 프론트(Cluster4CardContent.tsx) 의 윈도 매칭 규칙과 동일.
  const weekStart = card.startDate;
  const matched = weekStart
    ? snapshot.teamParts.find((row) => {
        if (!row.joined_at) return false;
        if (row.joined_at > weekStart) return false;
        if (row.left_at && row.left_at <= weekStart) return false;
        return true;
      }) ?? null
    : null;

  const managedTeamName = matched?.managed_team_id
    ? snapshot.managedTeamNameById.get(matched.managed_team_id) ?? null
    : null;

  const isOnboarding = Boolean(
    snapshot.onboardingWeekId &&
      card.weekId &&
      snapshot.onboardingWeekId === card.weekId,
  );

  return {
    generation: matched?.generation ?? null,
    managedTeamName,
    isOnboarding,
  };
}

// 주차 분류(라인 렌더 입력) — 단일 출처.
//   카드 경로(getCluster4WeeklyCardsFor*)와 성장 통일 경로(getUnifiedWeeklyGrowth)가 동일한
//   weekIds·restWeekIds·slotFailWeekIds·legacyWeekIds·confirmedWeekIds 를 공유하도록 파생 로직을
//   한 곳으로 모은다 → 두 경로가 fetchLineDetailsByWeek 에 완전히 동일한 입력을 넘겨 breakdown 이
//   구조적으로 일치한다(강화율 SoT 통일의 전제).
function deriveWeekClassification(
  weeklyCards: WeeklyCardDto[],
  effectiveFrom: string,
): {
  weekIds: string[];
  restWeekIds: Set<string>;
  slotFailWeekIds: Set<string>;
  legacyWeekIds: Set<string>;
  confirmedWeekIds: Set<string>;
} {
  const weekIds = weeklyCards
    .map((card) => card.weekId)
    .filter((weekId): weekId is string => Boolean(weekId));
  // 휴식 주차(personal_rest/official_rest)/전환 — competency placeholder 를 fail 로 강제하지 않기 위한 신호.
  const restWeekIds = new Set(
    weeklyCards
      .filter((card) => card.weekId && (card.isTransition || isRestWeek(card.resultStatus)))
      .map((card) => card.weekId as string),
  );
  // 허브/라인 체계 적용 주차: 필수 슬롯 fail 적용(판정 완료 + EFFECTIVE_FROM 이후 — 사용자 유형 무관).
  const slotFailWeekIds = buildSlotFailWeekIds(weeklyCards, effectiveFrom);
  // 레거시(허브 도입 전) 주차 — 통합 라인 단일 렌더 게이트. override 시 빈 집합(여름 렌더).
  const legacyWeekIds = buildLegacyWeekIds(weeklyCards, effectiveFrom);
  // 확정(공표) 주차 — resultStatus 가 success/fail (resolver 가 result_published_at 반영).
  const confirmedWeekIds = new Set(
    weeklyCards
      .filter(
        (card) =>
          card.weekId &&
          (card.resultStatus === "success" || card.resultStatus === "fail"),
      )
      .map((card) => card.weekId as string),
  );
  return { weekIds, restWeekIds, slotFailWeekIds, legacyWeekIds, confirmedWeekIds };
}

export async function getCluster4WeeklyCardsForAuthUser(
  authUserId: string,
  authEmail?: string | null,
): Promise<Cluster4WeeklyCardDto[]> {
  const [profileUserId, weeklyGrowth] = await Promise.all([
    resolveProfileUserId(authUserId, authEmail),
    getWeeklyGrowthByUserId(authUserId, authEmail),
  ]);

  if (!profileUserId || !weeklyGrowth) {
    throw new Cluster4WeeklyCardsError(404, "User profile not found.");
  }

  const { weekIds, restWeekIds, slotFailWeekIds, legacyWeekIds, confirmedWeekIds } =
    deriveWeekClassification(weeklyGrowth.weeklyCards, CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  // 관리(5) 슬롯 게이트: membership_level 심화/운영진만 개방 — 잠금 사용자는 분모 제외(해당 없음).
  const managementSlotOpen = await fetchManagementSlotOpen(profileUserId);
  const tLinesStart = Date.now();
  const [lineMap, headerSnapshot, peopleMap, actLogsByWeek] = await Promise.all([
    fetchLineDetailsByWeek(profileUserId, weekIds, restWeekIds, slotFailWeekIds, managementSlotOpen, confirmedWeekIds, legacyWeekIds),
    fetchHeaderExtrasSnapshot(profileUserId),
    // 위클리 평판/연계동료 + 인적사항 (주차별). 실패해도 빈 맵 폴백 → 카드 보호.
    fetchWeeklyPeopleByWeek(profileUserId, weekIds),
    // Detail Log 액트 내역(적립 원장 → startDate 버킷). 실패 시 빈 맵(카드 보호). (append-only, v30)
    loadActLogsByStartDate(profileUserId),
  ]);
  console.log(
    "[weekly-cards][timing] lineDetails+headerExtras",
    `${Date.now() - tLinesStart}ms`,
    `| weeks=${weekIds.length}`,
  );

  return withDetailLogMessageMeta(weeklyGrowth.weeklyCards.map((card) => {
    // 폴백(라인 맵 자체가 비어 있는 degenerate 경로) — 개설 신호가 없으므로 not_applicable.
    const lines = card.weekId
      ? (lineMap.get(card.weekId) ??
          PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId, false)))
      : PUBLIC_PARTS.map((p) => emptyLine(p, null, false));
    const people = card.weekId
      ? (peopleMap.get(card.weekId) ?? emptyWeeklyPeople())
      : emptyWeeklyPeople();
    // Detail Log 액트 내역 — startDate 기준 배분(없으면 []). 합성 weekId 안전. snapshot baking. (v30)
    const actLogs = card.startDate ? (actLogsByWeek.get(card.startDate) ?? []) : [];
    return {
      ...toWeeklyCardDto(
        card,
        lines,
        resolveHeaderExtras(card, headerSnapshot),
        people,
      ),
      actLogs,
    };
  }));
}

// ─────────────────────────────────────────────────────────────────────
// 강화율 SoT 통일 — 성장 화면(weekly-growth) DTO 의 허브 수치를 카드 경로(P1)와 동일하게 만든다.
//
//   문제: getWeeklyGrowth 는 자체 SQL 집계 + 레거시 override 로 허브별 완료/가용을 독립 재계산했는데,
//         이는 카드 경로(fetchLineDetailsByWeek → breakdownFromLines)와 손으로 미러링돼 드리프트했다
//         (특히 레거시 info 허브에서 대량 divergence). 카드(cluster-4-card)를 단일 SoT 로 확정한다.
//   해결: getWeeklyGrowth 가 만든 DTO 를 받아, 카드 경로와 "완전히 동일한" 라인 렌더(fetchLineDetailsByWeek)
//         결과에서 breakdownFromLines 로 허브 수치를 재산출해 각 카드의 weeklyGrowth/lineBreakdown 을
//         덮어쓴다. 시즌율(seasonGrowthRates)도 그 카드에서 다시 fold → 카드/성장/시즌이 한 source.
//   비용: getWeeklyGrowth(주차 분류·verdict·누적) 1회 + fetchLineDetailsByWeek 1회 = 카드 경로와 동일.
//         getWeeklyGrowth 내부의 허브 SQL 집계 결과는 여기서 폐기된다(후속 정리 대상 — 무해).
// ─────────────────────────────────────────────────────────────────────
async function applyUnifiedBreakdownToGrowth(
  profileUserId: string,
  growth: WeeklyGrowthDto,
  effectiveFrom: string,
): Promise<WeeklyGrowthDto> {
  const { weekIds, restWeekIds, slotFailWeekIds, legacyWeekIds, confirmedWeekIds } =
    deriveWeekClassification(growth.weeklyCards, effectiveFrom);
  const managementSlotOpen = await fetchManagementSlotOpen(profileUserId);
  const lineMap = await fetchLineDetailsByWeek(
    profileUserId,
    weekIds,
    restWeekIds,
    slotFailWeekIds,
    managementSlotOpen,
    confirmedWeekIds,
    legacyWeekIds,
  );

  const weeklyCards = growth.weeklyCards.map((card) => {
    // 카드 경로와 동일한 렌더 셀 집합. degenerate(빈 맵) 폴백도 카드 경로와 동일하게 na 라인 →
    // breakdownFromLines 가 0/0(분모 제외)으로 처리한다.
    const lines = card.weekId
      ? (lineMap.get(card.weekId) ??
          PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId, false)))
      : PUBLIC_PARTS.map((p) => emptyLine(p, null, false));
    // 휴식 주차는 카드 경로(toWeeklyCardDto)와 동일하게 빈 breakdown(가용 라인 미정 → 0/0).
    const rest = isRestWeek(card.resultStatus);
    const breakdown: WeeklyCardLineBreakdown = rest
      ? emptyBreakdown()
      : breakdownFromLines(lines);
    const completedLines =
      breakdown.info.completed +
      breakdown.ability.completed +
      breakdown.experience.completed +
      breakdown.career.completed;
    const availableLines =
      breakdown.info.available +
      breakdown.ability.available +
      breakdown.experience.available +
      breakdown.career.available;
    return {
      ...card,
      lineBreakdown: breakdown,
      weeklyGrowth: {
        completedLines,
        availableLines,
        rate: roundGrowthRate(completedLines, availableLines),
      },
    };
  });

  return {
    ...growth,
    weeklyCards,
    // 시즌율도 통일된 카드 수치에서 다시 fold(전환 주차 제외 — computeSeasonGrowthRates 규칙).
    seasonGrowthRates: computeSeasonGrowthRates(weeklyCards),
  };
}

// weekly-growth 라우트(고객/어드민) 진입점 — 카드 경로와 동일 SoT 로 강화율/총 N개/시즌율을 노출.
export async function getUnifiedWeeklyGrowth(
  profileUserId: string,
  opts: { effectiveFromOverride?: string } = {},
): Promise<WeeklyGrowthDto | null> {
  const effectiveFrom =
    opts.effectiveFromOverride ?? CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  const growth = await getWeeklyGrowth(profileUserId, {
    effectiveFromOverride: opts.effectiveFromOverride,
  });
  if (!growth) return null;
  return applyUnifiedBreakdownToGrowth(profileUserId, growth, effectiveFrom);
}

export async function getUnifiedWeeklyGrowthByUserId(
  authUserId: string,
  authEmail?: string | null,
): Promise<WeeklyGrowthDto | null> {
  const [profileUserId, growth] = await Promise.all([
    resolveProfileUserId(authUserId, authEmail),
    getWeeklyGrowthByUserId(authUserId, authEmail),
  ]);
  if (!profileUserId || !growth) return null;
  return applyUnifiedBreakdownToGrowth(
    profileUserId,
    growth,
    CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  );
}

export async function getCluster4WeeklyCardsForProfileUser(
  profileUserId: string,
  opts: { effectiveFromOverride?: string } = {},
): Promise<Cluster4WeeklyCardDto[]> {
  // 레거시 경계 오버라이드(테스트 시즌 시뮬레이션) — 기본=CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM.
  //   과거 날짜를 주면 카드 렌더/슬롯 fail/강화율/verdict 전 경로가 여름 정책으로 일관 전환.
  const effectiveFrom =
    opts.effectiveFromOverride ?? CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  const tGrowthStart = Date.now();
  const weeklyGrowth = await getWeeklyGrowth(profileUserId, {
    effectiveFromOverride: opts.effectiveFromOverride,
  });
  console.log(
    "[weekly-cards][timing] getWeeklyGrowth(profileUser)",
    `${Date.now() - tGrowthStart}ms`,
  );
  if (!weeklyGrowth) {
    throw new Cluster4WeeklyCardsError(404, "User profile not found.");
  }

  const { weekIds, restWeekIds, slotFailWeekIds, legacyWeekIds, confirmedWeekIds } =
    deriveWeekClassification(weeklyGrowth.weeklyCards, effectiveFrom);
  // 관리(5) 슬롯 게이트: membership_level 심화/운영진만 개방 — 잠금 사용자는 분모 제외(해당 없음).
  const managementSlotOpen = await fetchManagementSlotOpen(profileUserId);
  const tLinesStart = Date.now();
  const [lineMap, headerSnapshot, peopleMap, actLogsByWeek] = await Promise.all([
    fetchLineDetailsByWeek(profileUserId, weekIds, restWeekIds, slotFailWeekIds, managementSlotOpen, confirmedWeekIds, legacyWeekIds),
    fetchHeaderExtrasSnapshot(profileUserId),
    // 위클리 평판/연계동료 + 인적사항 (주차별). 실패해도 빈 맵 폴백 → 카드 보호.
    fetchWeeklyPeopleByWeek(profileUserId, weekIds),
    // Detail Log 액트 내역(적립 원장 → startDate 버킷). 실패 시 빈 맵(카드 보호). (append-only, v30)
    loadActLogsByStartDate(profileUserId),
  ]);
  console.log(
    "[weekly-cards][timing] lineDetails+headerExtras",
    `${Date.now() - tLinesStart}ms`,
    `| weeks=${weekIds.length}`,
  );

  return withDetailLogMessageMeta(weeklyGrowth.weeklyCards.map((card) => {
    // 폴백(라인 맵 자체가 비어 있는 degenerate 경로) — 개설 신호가 없으므로 not_applicable.
    const lines = card.weekId
      ? (lineMap.get(card.weekId) ??
          PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId, false)))
      : PUBLIC_PARTS.map((p) => emptyLine(p, null, false));
    const people = card.weekId
      ? (peopleMap.get(card.weekId) ?? emptyWeeklyPeople())
      : emptyWeeklyPeople();
    // Detail Log 액트 내역 — startDate 기준 배분(없으면 []). 합성 weekId 안전. snapshot baking. (v30)
    const actLogs = card.startDate ? (actLogsByWeek.get(card.startDate) ?? []) : [];
    return {
      ...toWeeklyCardDto(
        card,
        lines,
        resolveHeaderExtras(card, headerSnapshot),
        people,
      ),
      actLogs,
    };
  }));
}
