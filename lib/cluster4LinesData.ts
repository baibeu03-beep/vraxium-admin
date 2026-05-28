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
  canEditCluster4Line,
  type Cluster4LineCanEditReason,
} from "@/lib/cluster4LinePermission";

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
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function isSubmissionClosed(closesAt: string, now = new Date()) {
  return now.getTime() > new Date(closesAt).getTime();
}

// Maps the unified canEdit reason to the HTTP status this API previously emitted.
// Preserves the existing 4xx/501 contract while making the actual decision come from
// one helper shared with the admin ActivityTab.
function lineReasonToHttp(
  reason: Cluster4LineCanEditReason,
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
      return { status: 200, message: "ok" };
  }
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
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,submitted_at,updated_at")
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

// Strict gate for portal submit/update: requires target ownership AND the submission
// window to be open. Translates the unified reason → the HTTP status this API has
// historically returned (403 / 404 / 410 / 501).
async function requireEditableTarget(
  lineTargetId: string,
  profileUserId: string,
): Promise<Cluster4LineTargetJoinedRow> {
  const row = await fetchTargetById(lineTargetId);
  const decision = canEditCluster4Line(
    toPermissionTarget(row),
    profileUserId,
  );
  if (!decision.canEdit) {
    const http = lineReasonToHttp(decision.reason);
    throw new Cluster4PublicLineError(http.status, http.message);
  }
  return row;
}

function buildSubmissionPayload(input: Cluster4LineSubmissionInput) {
  return {
    subtitle: input.subtitle,
    output_link_2: input.outputLink2,
    output_link_3: input.outputLink3,
    output_link_4: input.outputLink4,
    output_link_5: input.outputLink5,
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
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,submitted_at,updated_at")
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
    .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,submitted_at,updated_at")
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Submission not found.");
  }
  return toSubmissionDto(data as unknown as Cluster4SubmissionRow);
}
