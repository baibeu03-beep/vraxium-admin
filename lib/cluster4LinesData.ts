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

function isWithinSubmissionWindow(opensAt: string, closesAt: string, now = new Date()) {
  const opens = new Date(opensAt).getTime();
  const closes = new Date(closesAt).getTime();
  const current = now.getTime();
  return opens <= current && current <= closes;
}

function isSubmissionClosed(closesAt: string, now = new Date()) {
  return now.getTime() > new Date(closesAt).getTime();
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

async function getAccessibleTargetById(
  lineTargetId: string,
  profileUserId: string,
) {
  if (!isUuid(lineTargetId)) {
    throw new Cluster4PublicLineError(400, "lineTargetId must be a UUID");
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_WITH_LINE_SELECT)
    .eq("id", lineTargetId)
    .eq("cluster4_lines.is_active", true)
    .maybeSingle();
  if (error) {
    throw new Cluster4PublicLineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4PublicLineError(404, "Line target not found.");
  }

  const row = data as unknown as Cluster4LineTargetJoinedRow;
  if (row.target_mode === "rule") {
    throw new Cluster4PublicLineError(
      501,
      "Rule-based line targets are not implemented yet.",
    );
  }
  if (row.target_user_id !== profileUserId) {
    throw new Cluster4PublicLineError(403, "This line target is not accessible.");
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
  const target = await getAccessibleTargetById(lineTargetId, profileUserId);
  const line = toVisibleLine(target);

  if (!isWithinSubmissionWindow(line.submissionOpensAt, line.submissionClosesAt)) {
    throw new Cluster4PublicLineError(410, "Submission window is closed.");
  }

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
  const target = await getAccessibleTargetById(lineTargetId, profileUserId);
  const line = toVisibleLine(target);

  if (!isWithinSubmissionWindow(line.submissionOpensAt, line.submissionClosesAt)) {
    throw new Cluster4PublicLineError(410, "Submission window is closed.");
  }

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
