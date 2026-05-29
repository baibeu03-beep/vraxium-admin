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
import { ceilGrowthRate } from "@/lib/lineAvailability";
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
import type {
  Cluster4LineDetailDto,
  Cluster4LineEditReason,
  Cluster4LinePartType,
  Cluster4LineSubmissionDto,
  Cluster4LineTargetMode,
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
    info_subtitle: string | null;
    info_growth_point: string | null;
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

type SubmissionRow = {
  id: string;
  line_target_id: string;
  subtitle: string | null;
  output_link_2: string | null;
  output_link_3: string | null;
  output_link_4: string | null;
  output_link_5: string | null;
  output_links: unknown;
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
    info_subtitle,
    info_growth_point,
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
): Cluster4LineDetailDto {
  // partType 단위 "미개설" placeholder. lineTargetId 가 없으므로 canEdit=false /
  // editReason="target_missing" 으로 고정 (override 가 OPEN 이어도 동일 — target 없는
  // sub-line 에는 override 가 적용되면 안 된다).
  // 강화 상태: 타깃 부재 = 미배정 = 제출 불필요 → not_applicable.
  // (weekly-cards 에는 "제출했어야 함" 을 판정할 신호가 없으므로 expectedWhenMissing=false 고정)
  const enhancement = computeCluster4Enhancement({
    hasTarget: false,
    deadlinePassed: false,
    hasSubmission: false,
    isCareer: partType === "career",
    expectedWhenMissing: false,
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
    careerProjectId: null,
    lineCode: null,
    projectCode: null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
    canEdit: false,
    editReason: "target_missing",
  };
}

function toSubmissionDto(row: SubmissionRow): Cluster4LineSubmissionDto {
  return {
    id: row.id,
    lineTargetId: row.line_target_id,
    subtitle: row.subtitle,
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
  // 강화 상태: 타깃이 존재하므로(1차 대상자) 마감 여부로만 success/pending 을 가른다.
  // 마감(submission_closes_at = 수 22:00 KST) 후면 미기입이라도 success.
  // submission 존재 여부는 submissionStatus 로만 분리 반영한다.
  const closesAt = line.submission_closes_at;
  const deadlinePassed =
    Boolean(closesAt) && Date.now() > new Date(closesAt).getTime();
  const enhancement = computeCluster4Enhancement({
    hasTarget: true,
    deadlinePassed,
    hasSubmission: Boolean(submission),
    isCareer: partType === "career",
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
    // 실무 정보(information) 라인만 노출. 그 외 part 는 null (운영자 입력 대상 아님).
    infoSubtitle: partType === "information" ? line.info_subtitle : null,
    infoGrowthPoint: partType === "information" ? line.info_growth_point : null,
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
    careerProjectId,
    lineCode: line.line_code,
    // career part 의 line_code 는 career_projects.line_code 와 동일 (= projectCode).
    projectCode: partType === "career" ? line.line_code : null,
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
      rate: ceilGrowthRate(b.completed, b.available),
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

function weekLabel(seasonName: string, weekNumber: number): string {
  return seasonName ? `${seasonName} ${weekNumber}w` : `${weekNumber}w`;
}

function cardMessage(card: WeeklyCardDto): string | null {
  if (card.resultStatus === "personal_rest") return "개인 휴식주";
  if (card.resultStatus === "official_rest") return "공식 휴식주";
  if (card.resultStatus === "running") return "성장 진행 중";
  if (card.resultStatus === "tallying") return "집계 중";
  return null;
}

function toWeeklyCardDto(
  card: WeeklyCardDto,
  lines: Cluster4LineDetailDto[],
): Cluster4WeeklyCardDto {
  const title = weekLabel(card.seasonName, card.weekNumber);
  const imageUrl = card.weekImagePath || null;
  const rest = isRestWeek(card.resultStatus);
  const fmScore = card.totalFmScoreRaw;
  const linesWithBreakdown = attachLineBreakdown(lines, card.lineBreakdown, rest);

  return {
    weekId: card.weekId,
    weekNumber: card.weekNumber,
    weekLabel: title,
    weekTitle: title,
    displayTitle: title,
    startDate: card.startDate,
    endDate: card.endDate,
    userWeekStatus: toUserWeekStatus(card.resultStatus),
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
    imageUrl,
    thumbnailUrl: imageUrl,
    cardMessage: cardMessage(card),
    titleText: title,
    lines: linesWithBreakdown,
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
): Promise<Map<string, Cluster4LineDetailDto[]>> {
  const result = new Map<string, Cluster4LineDetailDto[]>();
  if (weekIds.length === 0) return result;

  const [targetResult, editWindowByPart] = await Promise.all([
    supabaseAdmin
      .from("cluster4_line_targets")
      .select(TARGET_WITH_LINE_SELECT)
      .in("week_id", weekIds)
      .eq("cluster4_lines.is_active", true)
      .order("created_at", { ascending: false }),
    fetchHubEditWindows(profileUserId),
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
      .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,output_links,submitted_at,updated_at")
      .eq("user_id", profileUserId)
      .in("line_target_id", targetIds);

    if (submissionError) {
      throw new Cluster4WeeklyCardsError(500, submissionError.message);
    }

    for (const row of (submissionData ?? []) as SubmissionRow[]) {
      submissionsByTargetId.set(row.line_target_id, row);
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
        lines.push(emptyLine(partType, weekId));
      }
    }

    result.set(weekId, lines);
  }

  return result;
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
  const lineMap = await fetchLineDetailsByWeek(profileUserId, weekIds);

  return weeklyGrowth.weeklyCards.map((card) =>
    toWeeklyCardDto(
      card,
      card.weekId
        ? (lineMap.get(card.weekId) ?? PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId)))
        : PUBLIC_PARTS.map((p) => emptyLine(p, null)),
    ),
  );
}

export async function getCluster4WeeklyCardsForProfileUser(
  profileUserId: string,
): Promise<Cluster4WeeklyCardDto[]> {
  const weeklyGrowth = await getWeeklyGrowth(profileUserId);
  if (!weeklyGrowth) {
    throw new Cluster4WeeklyCardsError(404, "User profile not found.");
  }

  const weekIds = weeklyGrowth.weeklyCards
    .map((card) => card.weekId)
    .filter((weekId): weekId is string => Boolean(weekId));
  const lineMap = await fetchLineDetailsByWeek(profileUserId, weekIds);

  return weeklyGrowth.weeklyCards.map((card) =>
    toWeeklyCardDto(
      card,
      card.weekId
        ? (lineMap.get(card.weekId) ?? PUBLIC_PARTS.map((p) => emptyLine(p, card.weekId)))
        : PUBLIC_PARTS.map((p) => emptyLine(p, null)),
    ),
  );
}
