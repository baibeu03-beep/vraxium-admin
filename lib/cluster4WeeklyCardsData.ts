import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  getWeeklyGrowth,
  getWeeklyGrowthByUserId,
} from "@/lib/cluster4WeeklyGrowthData";
import type {
  WeekResultStatus,
  WeeklyCardDto,
  WeeklyCardLineBreakdown,
  WeeklyCardLineDetail,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  roundGrowthRate,
  fetchWeeksWithAnyInfoLine,
  fetchWeeksWithAnyExperienceLine,
} from "@/lib/lineAvailability";
import { normalizeOutputImages } from "@/lib/cluster4OutputImages";
import {
  CLUSTER4_HUB_EDIT_WINDOW_KEYS,
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  evaluateCluster4HubEdit,
  type Cluster4EditWindowSnapshot,
  type Cluster4HubEditDecisionReason,
} from "@/lib/cluster4LinePermission";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  type CareerGrade,
  careerRatingStatusFromGrade,
} from "@/lib/careerGrade";
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
  opened_at: string;
  expires_at: string;
};

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
    competency_line_master_id,
    experience_line_master_id,
    career_project_id
  )
`;

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
  restWeek = false,
): Cluster4LineDetailDto {
  // 미개설 placeholder — 타깃/평가가 없으므로 experienceRating 은 항상 null.
  // partType 단위 "미개설" placeholder. lineTargetId 가 없으므로 canEdit=false /
  // editReason="target_missing" 으로 고정 (override 가 OPEN 이어도 동일 — target 없는
  // sub-line 에는 override 가 적용되면 안 된다).
  // 강화 상태: 타깃 부재일 때 — 그 주차에 (해당 part) 라인이 개설됐으면 fail,
  // 미개설이면 not_applicable. expectedWhenMissing 이 그 신호다.
  //   info: weeksWithInfoLine.has(weekId) 를 전달 → fail/not_applicable 구분.
  // competency(실무 역량) 예외: 허브 정책상 not_applicable 이 절대 나오면 안 된다
  //   (라인 미개설/미배정 모두 fail). 따라서 호출부 신호와 무관하게 항상 fail 로 본다.
  // 단, 휴식 주차(personal_rest/official_rest)는 평가/집계 제외(void)이므로 competency 도
  //   fail 로 강제하지 않는다 — 휴식 상태가 not_applicable 제거 정책보다 우선한다.
  //   (DB status 는 그대로 personal_rest/official_rest, enhancementStatus 만 not_applicable.)
  const competencyExpectsFail = partType === "competency" && !restWeek;
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: partType === "career",
    expectedWhenMissing: competencyExpectsFail ? true : expectedWhenMissing,
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
  // 강화 상태: 타깃이 존재하므로(1차 대상자) 마감 여부로 success/pending 을 가른다.
  // 마감(submission_closes_at = 수 22:00 KST) 후면 미기입이라도 success.
  // career 는 추가로 평점을 반영한다 — 마감 후 D=fail / S~C=success / 미평가=pending(unevaluated).
  // submission 존재 여부는 submissionStatus 로만 분리 반영한다.
  const closesAt = line.submission_closes_at;
  const deadlinePassed =
    Boolean(closesAt) && Date.now() > new Date(closesAt).getTime();
  const enhancement = computeCluster4Enhancement({
    hasTarget: true,
    deadlinePassed,
    hasSubmission: Boolean(submission),
    isCareer: partType === "career",
    // career 만 평점 verdict 를 전달한다. 비career 는 undefined → 기존 동작(마감 후 success).
    careerGradeVerdict: partType === "career" ? careerRatingStatus : undefined,
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
    experienceRating:
      partType === "experience"
        ? experienceRatingByTargetId.get(target.id) ?? null
        : null,
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

type HeaderExtras = {
  generation: number | null;
  managedTeamName: string | null;
  isOnboarding: boolean;
};

function toWeeklyCardDto(
  card: WeeklyCardDto,
  lines: Cluster4LineDetailDto[],
  extras: HeaderExtras,
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
  const linesWithBreakdown = attachLineBreakdown(lines, card.lineBreakdown, rest);
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
    userWeekStatus: userWeekStatusValue,
    statusLabel: card.resultLabel,
    statusTone: statusTone(card.resultStatus),
    isRestWeek: rest,

    teamName: card.teamNameRaw,
    partName: card.partNameRaw,
    roleLabel: card.roleLabelRaw,
    membershipStatusLabel: card.membershipStatusLabelRaw,

    points: {
      star: card.pointsRaw,
      shield: card.advantagesRaw,
      lightning: card.penaltyRaw,
    },
    cumulativeInjeolmi: card.cumulativeAdvantages,
    fameScore: fmScore,
    fmScore,

    reputationCount: card.weeklyReputationCountRaw,
    reputationTotal: REPUTATION_TARGET,
    colleagueCount: card.linkedCrewCountRaw,
    colleagueTotal: COLLEAGUE_TARGET,

    weeklyGrowthRate: card.weeklyGrowth.rate,
    growthNumerator: card.weeklyGrowth.completedLines,
    growthDenominator: card.weeklyGrowth.availableLines,

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

// experience_line_master_id → {category, slotOrder} 일괄 룩업.
// experience sub-line 5슬롯 분류 노출용. 실패해도 카드를 깨뜨리지 않고 분류만 null 폴백한다.
async function fetchExperienceMasterMetaByIds(
  ids: string[],
): Promise<Map<string, ExperienceMasterMeta>> {
  const map = new Map<string, ExperienceMasterMeta>();
  if (ids.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("id,experience_category,experience_slot_order")
    .in("id", ids);
  if (error) {
    console.warn("[cluster4/weekly-cards] experience masters lookup failed", {
      message: error.message,
    });
    return map;
  }
  for (const row of (data ?? []) as {
    id: string;
    experience_category: Cluster4ExperienceCategory | null;
    experience_slot_order: number | null;
  }[]) {
    map.set(row.id, {
      category: row.experience_category ?? null,
      slotOrder: row.experience_slot_order ?? null,
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
      "id,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img",
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
  }[]) {
    map.set(row.id, {
      companyName: row.company_name ?? null,
      companyLogoUrl: row.company_logo_url ?? null,
      supervisorName: row.supervisor_name ?? null,
      supervisorDepartment: row.supervisor_department ?? null,
      supervisorPosition: row.supervisor_position ?? null,
      supervisorPhotoUrl: row.supervisor_profile_img ?? null,
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

// user_edit_windows.cluster4.work_* override 스냅샷을 DB part_type 별로 인덱싱한다.
// 누락된 키는 null (override 없음).
async function fetchHubEditWindows(
  profileUserId: string,
): Promise<Map<DbLinePartType, Cluster4EditWindowSnapshot>> {
  const map = new Map<DbLinePartType, Cluster4EditWindowSnapshot>();
  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .select("resource_key,opened_at,expires_at")
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
    map.set(dbPart, { openedAt: row.opened_at, expiresAt: row.expires_at });
  }
  return map;
}

async function fetchLineDetailsByWeek(
  profileUserId: string,
  weekIds: string[],
  restWeekIds: Set<string>,
): Promise<Map<string, Cluster4LineDetailDto[]>> {
  const result = new Map<string, Cluster4LineDetailDto[]>();
  if (weekIds.length === 0) return result;

  const [targetResult, editWindowByPart, weeksWithInfoLine, weeksWithExperienceLine] =
    await Promise.all([
      supabaseAdmin
        .from("cluster4_line_targets")
        .select(TARGET_WITH_LINE_SELECT)
        .in("week_id", weekIds)
        .eq("cluster4_lines.is_active", true)
        .order("created_at", { ascending: false }),
      fetchHubEditWindows(profileUserId),
      // 그 주차에 info 라인이 (누구든) 개설됐는지 — 미배정 시 fail/not_applicable 구분용.
      fetchWeeksWithAnyInfoLine(weekIds),
      // experience 도 동일하게 — 미배정 시 fail/not_applicable 구분용.
      fetchWeeksWithAnyExperienceLine(weekIds),
    ]);

  const { data: targetData, error: targetError } = targetResult;
  if (targetError) {
    throw new Cluster4WeeklyCardsError(500, targetError.message);
  }

  const targetRows = (targetData ?? []) as unknown as TargetWithLineRow[];
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
  const activityTypeIds = Array.from(
    new Set(
      relevantTargets
        .map((row) => row.cluster4_lines?.activity_type_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const activityTypeNameById =
    await fetchActivityTypeNamesByIds(activityTypeIds);

  // experience sub-line 5슬롯 분류 (experience_line_master_id → {category, slotOrder}) 일괄 룩업.
  const experienceMasterIds = Array.from(
    new Set(
      relevantTargets
        .filter((row) => row.cluster4_lines?.part_type === "experience")
        .map((row) => row.cluster4_lines?.experience_line_master_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const experienceMasterMetaById =
    await fetchExperienceMasterMetaByIds(experienceMasterIds);

  // career sub-line sponsor-card 메타 (career_project_id → 회사/감독자) 일괄 룩업.
  const careerProjectIds = Array.from(
    new Set(
      relevantTargets
        .filter((row) => row.cluster4_lines?.part_type === "career")
        .map((row) => row.cluster4_lines?.career_project_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const careerProjectMetaById =
    await fetchCareerProjectMetaByIds(careerProjectIds);

  const now = Date.now();
  for (const weekId of weekIds) {
    // 같은 주차의 user-mode target 만 카드에 매핑한다. 다른 주차의 target 은 절대
    // 현재 주차 카드에 영향을 주지 않는다 (weekly-cards 의 canEdit 매칭 단위는
    // weekId + lineTargetId).
    const weekTargets = relevantTargets.filter((row) => row.week_id === weekId);
    const lines: Cluster4LineDetailDto[] = [];
    const partsWithTarget = new Set<Cluster4LinePartType>();

    for (const target of weekTargets) {
      const base = toLineDetail(
        target,
        submissionsByTargetId.get(target.id) ?? null,
        activityTypeNameById,
        experienceRatingByTargetId,
        experienceMasterMetaById,
        careerGradeByTargetId,
        careerProjectMetaById,
      );
      if (!base) continue;
      const dbPartType = target.cluster4_lines?.part_type;
      // evaluateCluster4HubEdit 는 단일 line target 단위로 ownership / window 를 평가.
      // editWindow override 가 OPEN 이면 마감된 line target 의 canEdit 만 ok_override
      // 로 우회되며, target 이 없는 sub-line 에는 (애초에 이 루프 자체가 돌지 않으므로)
      // 적용되지 않는다 — 정책 4번 "target 없는 라인에 override 가 적용되지 않는다" 보장.
      const decision = evaluateCluster4HubEdit({
        target: toPermissionTarget(target),
        editWindow: dbPartType ? editWindowByPart.get(dbPartType) ?? null : null,
        profileUserId,
        now,
      });
      lines.push({
        ...base,
        canEdit: decision.canEdit,
        editReason: decisionReasonToDto(decision.reason),
      });
      partsWithTarget.add(base.partType);
    }

    // partType 단위로 target 이 하나도 없는 경우에 한해 "미개설" placeholder 1행을
    // 유지한다 (UI 의 partType 카드 자체가 비어 보이지 않도록 — 기존 호환). 이 placeholder
    // 는 lineTargetId 가 없어 canEdit=false / editReason="target_missing" 으로 고정.
    for (const partType of PUBLIC_PARTS) {
      if (!partsWithTarget.has(partType)) {
        // 미배정: 그 주차에 해당 part 라인이 개설됐으면 fail, 미개설이면 not_applicable.
        //   info       → weeksWithInfoLine
        //   experience → weeksWithExperienceLine
        //   competency → emptyLine 내부에서 fail 강제 (단, 휴식 주차는 제외 — restWeek 신호)
        //   (career 는 이번 범위 밖 — 기존대로 not_applicable)
        const expectedWhenMissing =
          (partType === "information" && weeksWithInfoLine.has(weekId)) ||
          (partType === "experience" && weeksWithExperienceLine.has(weekId));
        lines.push(
          emptyLine(partType, weekId, expectedWhenMissing, restWeekIds.has(weekId)),
        );
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

  const weekIds = weeklyGrowth.weeklyCards
    .map((card) => card.weekId)
    .filter((weekId): weekId is string => Boolean(weekId));
  // 휴식 주차(personal_rest/official_rest) — competency placeholder 를 fail 로 강제하지 않기 위한 신호.
  const restWeekIds = new Set(
    weeklyGrowth.weeklyCards
      .filter((card) => card.weekId && (card.isTransition || isRestWeek(card.resultStatus)))
      .map((card) => card.weekId as string),
  );
  const tLinesStart = Date.now();
  const [lineMap, headerSnapshot] = await Promise.all([
    fetchLineDetailsByWeek(profileUserId, weekIds, restWeekIds),
    fetchHeaderExtrasSnapshot(profileUserId),
  ]);
  console.log(
    "[weekly-cards][timing] lineDetails+headerExtras",
    `${Date.now() - tLinesStart}ms`,
    `| weeks=${weekIds.length}`,
  );

  return weeklyGrowth.weeklyCards.map((card) => {
    const restWeek = card.isTransition || isRestWeek(card.resultStatus);
    const lines = card.weekId
      ? (lineMap.get(card.weekId) ??
          PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId, false, restWeek)))
      : PUBLIC_PARTS.map((p) => emptyLine(p, null, false, restWeek));
    return toWeeklyCardDto(card, lines, resolveHeaderExtras(card, headerSnapshot));
  });
}

export async function getCluster4WeeklyCardsForProfileUser(
  profileUserId: string,
): Promise<Cluster4WeeklyCardDto[]> {
  const tGrowthStart = Date.now();
  const weeklyGrowth = await getWeeklyGrowth(profileUserId);
  console.log(
    "[weekly-cards][timing] getWeeklyGrowth(profileUser)",
    `${Date.now() - tGrowthStart}ms`,
  );
  if (!weeklyGrowth) {
    throw new Cluster4WeeklyCardsError(404, "User profile not found.");
  }

  const weekIds = weeklyGrowth.weeklyCards
    .map((card) => card.weekId)
    .filter((weekId): weekId is string => Boolean(weekId));
  // 휴식 주차(personal_rest/official_rest) — competency placeholder 를 fail 로 강제하지 않기 위한 신호.
  const restWeekIds = new Set(
    weeklyGrowth.weeklyCards
      .filter((card) => card.weekId && (card.isTransition || isRestWeek(card.resultStatus)))
      .map((card) => card.weekId as string),
  );
  const tLinesStart = Date.now();
  const [lineMap, headerSnapshot] = await Promise.all([
    fetchLineDetailsByWeek(profileUserId, weekIds, restWeekIds),
    fetchHeaderExtrasSnapshot(profileUserId),
  ]);
  console.log(
    "[weekly-cards][timing] lineDetails+headerExtras",
    `${Date.now() - tLinesStart}ms`,
    `| weeks=${weekIds.length}`,
  );

  return weeklyGrowth.weeklyCards.map((card) => {
    const restWeek = card.isTransition || isRestWeek(card.resultStatus);
    const lines = card.weekId
      ? (lineMap.get(card.weekId) ??
          PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId, false, restWeek)))
      : PUBLIC_PARTS.map((p) => emptyLine(p, null, false, restWeek));
    return toWeeklyCardDto(card, lines, resolveHeaderExtras(card, headerSnapshot));
  });
}
