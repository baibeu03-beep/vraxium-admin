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
import type {
  Cluster4LineDetailDto,
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
    output_link_1: string | null;
    submission_opens_at: string;
    submission_closes_at: string;
    is_active: boolean;
  } | null;
};

type SubmissionRow = {
  id: string;
  line_target_id: string;
  subtitle: string | null;
  output_link_2: string | null;
  output_link_3: string | null;
  output_link_4: string | null;
  output_link_5: string | null;
  submitted_at: string;
  updated_at: string;
};

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
    submission_opens_at,
    submission_closes_at,
    is_active
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

function emptyLine(partType: Cluster4LinePartType): Cluster4LineDetailDto {
  return {
    partType,
    status: "void",
    statusLabel: "미개설",
    lineId: null,
    lineTargetId: null,
    targetMode: null,
    mainTitle: null,
    outputLink1: null,
    submissionOpensAt: null,
    submissionClosesAt: null,
    submission: null,
    numerator: null,
    denominator: null,
    rate: null,
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
      return "제출 대기";
    case "success":
      return "제출 완료";
    case "fail":
      return "미제출";
  }
}

function toLineDetail(
  target: TargetWithLineRow,
  submission: SubmissionRow | null,
): Cluster4LineDetailDto | null {
  const line = target.cluster4_lines;
  if (!line) return null;
  const status = computeLineStatus(target, submission);
  return {
    partType: toPublicPart(line.part_type),
    status,
    statusLabel: lineStatusLabel(status),
    lineId: line.id,
    lineTargetId: target.id,
    targetMode: target.target_mode,
    mainTitle: line.main_title,
    outputLink1: line.output_link_1,
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
    submission: submission ? toSubmissionDto(submission) : null,
    numerator: null,
    denominator: null,
    rate: null,
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

function chooseTarget(
  rows: TargetWithLineRow[],
  profileUserId: string,
): TargetWithLineRow | null {
  return (
    rows.find((row) => row.target_mode === "user" && row.target_user_id === profileUserId) ??
    null
  );
}

async function fetchLineDetailsByWeek(
  profileUserId: string,
  weekIds: string[],
): Promise<Map<string, Cluster4LineDetailDto[]>> {
  const result = new Map<string, Cluster4LineDetailDto[]>();
  if (weekIds.length === 0) return result;

  const { data: targetData, error: targetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .in("week_id", weekIds)
    .eq("cluster4_lines.is_active", true)
    .order("created_at", { ascending: false });

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
      .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,submitted_at,updated_at")
      .eq("user_id", profileUserId)
      .in("line_target_id", targetIds);

    if (submissionError) {
      throw new Cluster4WeeklyCardsError(500, submissionError.message);
    }

    for (const row of (submissionData ?? []) as SubmissionRow[]) {
      submissionsByTargetId.set(row.line_target_id, row);
    }
  }

  for (const weekId of weekIds) {
    const weekTargets = targetRows.filter((row) => row.week_id === weekId);
    const lines = PUBLIC_PARTS.map((partType) => {
      const dbPartType: DbLinePartType = partType === "information" ? "info" : partType;
      const candidates = weekTargets.filter(
        (row) => row.cluster4_lines?.part_type === dbPartType,
      );
      const target = chooseTarget(candidates, profileUserId);
      if (!target) return emptyLine(partType);
      return (
        toLineDetail(target, submissionsByTargetId.get(target.id) ?? null) ??
        emptyLine(partType)
      );
    });
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
        ? (lineMap.get(card.weekId) ?? PUBLIC_PARTS.map(emptyLine))
        : PUBLIC_PARTS.map(emptyLine),
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
        ? (lineMap.get(card.weekId) ?? PUBLIC_PARTS.map(emptyLine))
        : PUBLIC_PARTS.map(emptyLine),
    ),
  );
}
