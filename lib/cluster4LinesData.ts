import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import type {
  Cluster4LineDetailDto,
  Cluster4LinePartType,
  Cluster4LineSubmissionDto,
  Cluster4LineSubmissionInput,
  Cluster4VisibleLineDto,
} from "@/lib/cluster4LinesTypes";
import {
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  evaluateCluster4HubEdit,
  type Cluster4EditWindowSnapshot,
  type Cluster4HubEditDecisionReason,
} from "@/lib/cluster4LinePermission";
import {
  resolveOutputLinks,
  outputLinksToLegacySlots,
} from "@/lib/cluster4OutputLinks";

export class Cluster4PublicLineError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Cluster4PublicLineError";
    this.status = status;
  }
}

type Cluster4LineTargetJoinedRow = {
  id: string;
  line_id: string;
  week_id: string;
  target_mode: "user" | "rule";
  target_user_id: string | null;
  target_rule: Record<string, unknown> | null;
  cluster4_lines: {
    id: string;
    part_type: Cluster4LinePartType;
    main_title: string;
    output_link_1: string | null;
    output_links: unknown;
    submission_opens_at: string;
    submission_closes_at: string;
    is_active: boolean;
  } | null;
};

type Cluster4SubmissionRow = {
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
    submission_opens_at,
    submission_closes_at,
    is_active
  )
`;

function toVisibleLine(row: Cluster4LineTargetJoinedRow): Cluster4VisibleLineDto {
  const line = row.cluster4_lines;
  if (!line) {
    throw new Cluster4PublicLineError(500, "cluster4 line join missing");
  }
  return {
    lineId: line.id,
    lineTargetId: row.id,
    partType: line.part_type,
    targetMode: row.target_mode,
    mainTitle: line.main_title,
    outputLink1: line.output_link_1,
    outputLinks: resolveOutputLinks(line.output_links, [line.output_link_1]),
    submissionOpensAt: line.submission_opens_at,
    submissionClosesAt: line.submission_closes_at,
  };
}

function toSubmissionDto(row: Cluster4SubmissionRow): Cluster4LineSubmissionDto {
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

function isSubmissionClosed(closesAt: string, now = new Date()) {
  return now.getTime() > new Date(closesAt).getTime();
}

// Maps the unified hub edit reason to the HTTP status this API previously emitted.
// Preserves the existing 4xx/501 contract. ok_override 는 운영자 user_edit_windows
// override 가 OPEN 인 경우로, ok 와 동일하게 200 으로 처리한다.
function hubReasonToHttp(
  reason: Cluster4HubEditDecisionReason,
): { status: number; message: string } {
  switch (reason) {
    case "target_missing":
      return { status: 404, message: "Line target not found." };
    case "unsupported_target_mode":
      return {
        status: 501,
        message: "Rule-based line targets are not implemented yet.",
      };
    case "line_inactive":
      return { status: 410, message: "Line is not active." };
    case "not_owner":
      return { status: 403, message: "This line target is not accessible." };
    case "window_not_open":
      return { status: 410, message: "Submission window is not open yet." };
    case "window_closed":
      return { status: 410, message: "Submission window is closed." };
    case "ok":
    case "ok_override":
      return { status: 200, message: "ok" };
  }
}

// 해당 part_type 의 cluster4.work_* override 스냅샷을 조회한다. 없으면 null.
async function fetchHubEditWindow(
  profileUserId: string,
  partType: Cluster4LinePartType,
): Promise<Cluster4EditWindowSnapshot> {
  const resourceKey = PART_TYPE_TO_EDIT_WINDOW_KEY[partType];
  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .select("opened_at,expires_at")
    .eq("user_id", profileUserId)
    .eq("resource_key", resourceKey)
    .maybeSingle();
  if (error) {
    // 누락 테이블 등은 strict 정책으로 폴백.
    console.warn("[cluster4/lines] user_edit_windows lookup failed", {
      message: error.message,
      resourceKey,
    });
    return null;
  }
  if (!data) return null;
  return {
    openedAt: (data as { opened_at: string }).opened_at,
    expiresAt: (data as { expires_at: string }).expires_at,
  };
}

function toPermissionTarget(row: Cluster4LineTargetJoinedRow) {
  return {
    target_mode: row.target_mode,
    target_user_id: row.target_user_id,
    line: row.cluster4_lines
      ? {
          is_active: row.cluster4_lines.is_active,
          submission_opens_at: row.cluster4_lines.submission_opens_at,
          submission_closes_at: row.cluster4_lines.submission_closes_at,
        }
      : null,
  };
}

async function resolveAuthenticatedProfileUserId(authUserId: string, authEmail?: string | null) {
  const profileUserId = await resolveProfileUserId(authUserId, authEmail);
  if (!profileUserId) {
    throw new Cluster4PublicLineError(404, "User profile not found.");
  }
  return profileUserId;
}

async function listCandidateTargetsForUser(
  profileUserId: string,
  weekId: string,
  partType: Cluster4LinePartType,
) {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .eq("week_id", weekId)
    .eq("cluster4_lines.part_type", partType)
    .eq("cluster4_lines.is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }

  const rows = (data ?? []) as unknown as Cluster4LineTargetJoinedRow[];
  const supported = rows.filter((row) => row.target_mode === "user");
  const matched = supported.find((row) => row.target_user_id === profileUserId) ?? null;
  const hasRuleTargets = rows.some((row) => row.target_mode === "rule");
  return { matched, hasRuleTargets };
}

async function getSubmissionForTargetAndUser(lineTargetId: string, profileUserId: string) {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,output_links,submitted_at,updated_at")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  return (data ?? null) as Cluster4SubmissionRow | null;
}

// Fetches the target row by id; ownership / window checks are handled separately by
// the unified canEditCluster4Line helper so admin and portal paths agree on policy.
async function fetchTargetById(lineTargetId: string) {
  if (!isUuid(lineTargetId)) {
    throw new Cluster4PublicLineError(400, "lineTargetId must be a UUID");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .eq("id", lineTargetId)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Line target not found.");
  }

  return data as unknown as Cluster4LineTargetJoinedRow;
}

// 포털 submit/update 게이트. ownership 은 항상 강제하되, submission window 가 닫혀 있어도
// user_edit_windows.cluster4.work_<hub> override 가 OPEN 이면 ok_override 로 저장을 허용한다.
// 어드민 ActivityTab(evaluateCluster4HubEdit) 과 동일한 정책. canEdit=true 인 weekly-cards
// DTO 와 실제 저장 API 결과가 일치하도록 한다.
async function requireEditableTarget(
  lineTargetId: string,
  profileUserId: string,
): Promise<Cluster4LineTargetJoinedRow> {
  const row = await fetchTargetById(lineTargetId);
  const partType = row.cluster4_lines?.part_type ?? null;
  const editWindow = partType
    ? await fetchHubEditWindow(profileUserId, partType)
    : null;
  const decision = evaluateCluster4HubEdit({
    target: toPermissionTarget(row),
    editWindow,
    profileUserId,
  });
  if (!decision.canEdit) {
    const http = hubReasonToHttp(decision.reason);
    throw new Cluster4PublicLineError(http.status, http.message);
  }
  return row;
}

function buildSubmissionPayload(input: Cluster4LineSubmissionInput) {
  // output_links 가 canonical. 레거시 output_link_2~5 는 backward-compat mirror.
  // 제출 슬롯은 4개(2~5) 이므로 jsonb 의 앞 4개 url 을 mirror 한다.
  const [link2, link3, link4, link5] = outputLinksToLegacySlots(input.outputLinks, 4);
  return {
    subtitle: input.subtitle,
    output_link_2: link2,
    output_link_3: link3,
    output_link_4: link4,
    output_link_5: link5,
    output_links: input.outputLinks,
  };
}

export async function getCluster4LineDetailForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  weekId: string,
  partType: Cluster4LinePartType,
): Promise<Cluster4LineDetailDto> {
  if (!isUuid(weekId)) {
    throw new Cluster4PublicLineError(400, "weekId must be a UUID");
  }
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  const { matched, hasRuleTargets } = await listCandidateTargetsForUser(
    profileUserId,
    weekId,
    partType,
  );

  if (!matched) {
    if (hasRuleTargets) {
      console.warn(
        "[cluster4/lines/detail] rule target candidates exist but evaluator is not implemented",
        { profileUserId, weekId, partType },
      );
    }
    return {
      status: "void",
      partType,
      line: null,
      submission: null,
    };
  }

  const line = toVisibleLine(matched);
  const submission = await getSubmissionForTargetAndUser(matched.id, profileUserId);
  if (submission) {
    return {
      status: "success",
      partType,
      line,
      submission: toSubmissionDto(submission),
    };
  }

  const status = isSubmissionClosed(line.submissionClosesAt) ? "fail" : "pending";
  return {
    status,
    partType,
    line,
    submission: null,
  };
}

export async function createCluster4LineSubmissionForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  await requireEditableTarget(lineTargetId, profileUserId);

  const existing = await getSubmissionForTargetAndUser(lineTargetId, profileUserId);
  if (existing) {
    throw new Cluster4PublicLineError(409, "Submission already exists.");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .insert({
      line_target_id: lineTargetId,
      user_id: profileUserId,
      ...buildSubmissionPayload(input),
    })
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,output_links,submitted_at,updated_at")
    .single();
  if (error || !data) {
    throw new Cluster4PublicLineError(
      500,
      error?.message ?? "Failed to create submission.",
    );
  }
  return toSubmissionDto(data as unknown as Cluster4SubmissionRow);
}

export async function updateCluster4LineSubmissionForAuthUser(
  authUserId: string,
  authEmail: string | null | undefined,
  lineTargetId: string,
  input: Cluster4LineSubmissionInput,
): Promise<Cluster4LineSubmissionDto> {
  const profileUserId = await resolveAuthenticatedProfileUserId(authUserId, authEmail);
  await requireEditableTarget(lineTargetId, profileUserId);

  const existing = await getSubmissionForTargetAndUser(lineTargetId, profileUserId);
  if (!existing) {
    throw new Cluster4PublicLineError(404, "Submission not found.");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .update(buildSubmissionPayload(input))
    .eq("id", existing.id)
    .eq("user_id", profileUserId)
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,output_links,submitted_at,updated_at")
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Submission not found.");
  }
  return toSubmissionDto(data as unknown as Cluster4SubmissionRow);
}
