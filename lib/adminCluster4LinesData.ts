import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import type {
  Cluster4InfoLineDetail,
  Cluster4InfoLineTargetDetail,
  Cluster4LineDto,
  Cluster4LinePatchInput,
  Cluster4LineTargetCreateInput,
  Cluster4LineTargetDto,
  Cluster4LineTargetPatchInput,
  Cluster4LineUpsertInput,
  ListCluster4InfoLinesDetailedResult,
  ListCluster4LinesDetailedResult,
  ListCluster4LinesResult,
  ListCluster4LineTargetsResult,
} from "@/lib/adminCluster4LinesTypes";
import {
  evaluateCluster4HubEdit,
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  type Cluster4EditWindowSnapshot,
} from "@/lib/cluster4LinePermission";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import {
  outputImageUrls,
  outputImageCaptions as outputImageCaptionList,
} from "@/lib/cluster4OutputImages";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";

export class Cluster4LineError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Cluster4LineError";
    this.status = status;
  }
}

type Cluster4LineRow = {
  id: string;
  part_type: Cluster4LineDto["partType"];
  activity_type_id: string | null;
  line_code: string | null;
  main_title: string;
  info_subtitle: string | null;
  info_growth_point: string | null;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: unknown;
  // 레거시 string[] · 신규 [{url,caption}] 혼재 가능 → unknown 으로 받아 정규화.
  output_images: unknown;
  submission_opens_at: string;
  submission_closes_at: string;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type Cluster4LineTargetRow = {
  id: string;
  line_id: string;
  week_id: string;
  target_mode: Cluster4LineTargetDto["targetMode"];
  target_user_id: string | null;
  target_rule: Record<string, unknown> | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type Cluster4SubmissionCountRow = {
  line_target_id: string;
};

const LINE_SELECT =
  "id,part_type,activity_type_id,line_code,main_title,info_subtitle,info_growth_point,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_by,updated_by,created_at,updated_at";
const TARGET_SELECT =
  "id,line_id,week_id,target_mode,target_user_id,target_rule,created_by,updated_by,created_at,updated_at";

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

function toLineDto(
  row: Cluster4LineRow,
  targetCount: number,
  submissionCount: number,
): Cluster4LineDto {
  return {
    id: row.id,
    partType: row.part_type,
    activityTypeId: row.activity_type_id,
    lineCode: row.line_code ?? null,
    mainTitle: row.main_title,
    infoSubtitle: row.info_subtitle ?? null,
    infoGrowthPoint: row.info_growth_point ?? null,
    outputLink1: row.output_link_1,
    outputLink2: row.output_link_2,
    outputLinks: resolveOutputLinks(row.output_links, [
      row.output_link_1,
      row.output_link_2,
    ]),
    // output_images 는 레거시 string[] · 신규 [{url,caption}] 두 형태가 섞일 수 있어 정규화.
    outputImages: outputImageUrls(row.output_images),
    outputImageCaptions: outputImageCaptionList(row.output_images),
    submissionOpensAt: row.submission_opens_at,
    submissionClosesAt: row.submission_closes_at,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targetCount,
    submissionCount,
  };
}

function toTargetDto(
  row: Cluster4LineTargetRow,
  submissionCount: number,
): Cluster4LineTargetDto {
  return {
    id: row.id,
    lineId: row.line_id,
    weekId: row.week_id,
    targetMode: row.target_mode,
    targetUserId: row.target_user_id,
    targetRule: row.target_rule ?? {},
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submissionCount,
  };
}

function linePayload(
  input: Cluster4LineUpsertInput | Cluster4LinePatchInput,
  actorAdminId: string,
  mode: "create" | "update",
) {
  const payload: Record<string, unknown> = {
    updated_by: actorAdminId,
  };
  if ("partType" in input && input.partType !== undefined) payload.part_type = input.partType;
  if ("activityTypeId" in input && input.activityTypeId !== undefined) {
    payload.activity_type_id = input.activityTypeId?.trim() || null;
  }
  if ("mainTitle" in input && input.mainTitle !== undefined) payload.main_title = input.mainTitle.trim();
  if ("infoSubtitle" in input && input.infoSubtitle !== undefined) {
    payload.info_subtitle = input.infoSubtitle?.trim() || null;
  }
  if ("infoGrowthPoint" in input && input.infoGrowthPoint !== undefined) {
    payload.info_growth_point = input.infoGrowthPoint?.trim() || null;
  }
  if ("outputLink1" in input && input.outputLink1 !== undefined) {
    payload.output_link_1 = input.outputLink1?.trim() || null;
  }
  if ("outputLink2" in input && input.outputLink2 !== undefined) {
    payload.output_link_2 = input.outputLink2?.trim() || null;
  }
  // output_links (URL + label) canonical 저장. 레거시 output_link_1/2 는 위에서 mirror 됨.
  if ("outputLinks" in input && input.outputLinks !== undefined) {
    payload.output_links = input.outputLinks;
  }
  if ("outputImages" in input && input.outputImages !== undefined) {
    payload.output_images = input.outputImages;
  }
  if ("submissionOpensAt" in input && input.submissionOpensAt !== undefined) {
    payload.submission_opens_at = input.submissionOpensAt;
  }
  if ("submissionClosesAt" in input && input.submissionClosesAt !== undefined) {
    payload.submission_closes_at = input.submissionClosesAt;
  }
  if ("isActive" in input && input.isActive !== undefined) payload.is_active = input.isActive;
  if (mode === "create") {
    payload.created_by = actorAdminId;
  }
  return payload;
}

function targetPayload(
  input: Cluster4LineTargetCreateInput | Cluster4LineTargetPatchInput,
  actorAdminId: string,
  mode: "create" | "update",
) {
  const payload: Record<string, unknown> = {
    updated_by: actorAdminId,
  };
  if ("weekId" in input && input.weekId !== undefined) payload.week_id = input.weekId;
  if ("targetMode" in input && input.targetMode !== undefined) payload.target_mode = input.targetMode;
  if ("targetUserId" in input && input.targetUserId !== undefined) payload.target_user_id = input.targetUserId;
  if ("targetRule" in input && input.targetRule !== undefined) payload.target_rule = input.targetRule;
  if (mode === "create") {
    payload.created_by = actorAdminId;
  }
  return payload;
}

async function ensureLineExists(lineId: string) {
  if (!isUuid(lineId)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("id", lineId)
    .maybeSingle();
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
}

async function ensureWeekExists(weekId: string) {
  if (!isUuid(weekId)) {
    throw new Cluster4LineError(400, "week_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin.from("weeks").select("id").eq("id", weekId).maybeSingle();
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4LineError(404, "week not found");
  }
}

async function ensureTargetUserExists(userId: string) {
  if (!isUuid(userId)) {
    throw new Cluster4LineError(400, "target_user_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4LineError(404, "target user not found");
  }
}

async function fetchTargetCountsByLineIds(lineIds: string[]) {
  const targetCounts = new Map<string, number>();
  const submissionCounts = new Map<string, number>();
  if (lineIds.length === 0) return { targetCounts, submissionCounts };

  const { data: targetRows, error: targetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,line_id")
    .in("line_id", lineIds);
  if (targetError) {
    throw new Cluster4LineError(500, targetError.message);
  }

  const targetIds: string[] = [];
  const targetIdToLineId = new Map<string, string>();
  for (const row of (targetRows ?? []) as Array<{ id: string; line_id: string }>) {
    targetCounts.set(row.line_id, (targetCounts.get(row.line_id) ?? 0) + 1);
    targetIds.push(row.id);
    targetIdToLineId.set(row.id, row.line_id);
  }

  if (targetIds.length === 0) return { targetCounts, submissionCounts };

  const { data: submissionRows, error: submissionError } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("line_target_id")
    .in("line_target_id", targetIds);
  if (submissionError) {
    throw new Cluster4LineError(500, submissionError.message);
  }

  for (const row of (submissionRows ?? []) as Cluster4SubmissionCountRow[]) {
    const lineId = targetIdToLineId.get(row.line_target_id);
    if (!lineId) continue;
    submissionCounts.set(lineId, (submissionCounts.get(lineId) ?? 0) + 1);
  }

  return { targetCounts, submissionCounts };
}

async function fetchSubmissionCountsByTargetIds(targetIds: string[]) {
  const counts = new Map<string, number>();
  if (targetIds.length === 0) return counts;
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("line_target_id")
    .in("line_target_id", targetIds);
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  for (const row of (data ?? []) as Cluster4SubmissionCountRow[]) {
    counts.set(row.line_target_id, (counts.get(row.line_target_id) ?? 0) + 1);
  }
  return counts;
}

function translatePostgrestError(message: string, code?: string) {
  if (code === "23505") return new Cluster4LineError(409, message);
  if (code === "23503") return new Cluster4LineError(404, message);
  if (code === "23514") return new Cluster4LineError(400, message);
  return new Cluster4LineError(500, message);
}

export type ListCluster4LinesOptions = {
  partType?: Cluster4LineDto["partType"] | null;
  weekId?: string | null;
  targetMode?: Cluster4LineTargetDto["targetMode"] | null;
  query?: string | null;
  limit?: number;
  offset?: number;
};

export async function listCluster4Lines(
  options: ListCluster4LinesOptions,
): Promise<ListCluster4LinesResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let lineIdsFilter: string[] | null = null;
  if (options.weekId || options.targetMode) {
    let targetQuery = supabaseAdmin.from("cluster4_line_targets").select("line_id");
    if (options.weekId) targetQuery = targetQuery.eq("week_id", options.weekId);
    if (options.targetMode) targetQuery = targetQuery.eq("target_mode", options.targetMode);
    const { data: targetRows, error: targetError } = await targetQuery;
    if (targetError) {
      throw new Cluster4LineError(500, targetError.message);
    }
    lineIdsFilter = Array.from(
      new Set(
        ((targetRows ?? []) as Array<{ line_id: string | null }>)
          .map((row) => row.line_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    );
    if (lineIdsFilter.length === 0) {
      return { rows: [], total: 0, limit, offset };
    }
  }

  let queryBuilder = supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_SELECT, { count: "exact" });

  if (options.partType) {
    queryBuilder = queryBuilder.eq("part_type", options.partType);
  }
  if (lineIdsFilter) {
    queryBuilder = queryBuilder.in("id", lineIdsFilter);
  }

  const rawQuery = options.query?.trim() ?? "";
  if (rawQuery.length > 0) {
    const escaped = escapeForIlike(rawQuery);
    if (escaped.length > 0) {
      const filters = [`main_title.ilike.%${escaped}%`, `output_link_1.ilike.%${escaped}%`];
      if (isUuid(rawQuery)) filters.push(`id.eq.${rawQuery}`);
      queryBuilder = queryBuilder.or(filters.join(","));
    } else if (isUuid(rawQuery)) {
      queryBuilder = queryBuilder.eq("id", rawQuery);
    }
  }

  queryBuilder = queryBuilder
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }

  const rows = (data ?? []) as unknown as Cluster4LineRow[];
  const { targetCounts, submissionCounts } = await fetchTargetCountsByLineIds(
    rows.map((row) => row.id),
  );
  return {
    rows: rows.map((row) =>
      toLineDto(
        row,
        targetCounts.get(row.id) ?? 0,
        submissionCounts.get(row.id) ?? 0,
      ),
    ),
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function getCluster4Line(id: string): Promise<Cluster4LineDto> {
  if (!isUuid(id)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
  const { targetCounts, submissionCounts } = await fetchTargetCountsByLineIds([id]);
  return toLineDto(
    data as unknown as Cluster4LineRow,
    targetCounts.get(id) ?? 0,
    submissionCounts.get(id) ?? 0,
  );
}

export async function createCluster4Line(
  input: Cluster4LineUpsertInput,
  actorAdminId: string,
): Promise<Cluster4LineDto> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .insert(linePayload(input, actorAdminId, "create"))
    .select(LINE_SELECT)
    .single();
  if (error || !data) {
    throw translatePostgrestError(
      error?.message ?? "Failed to create cluster4 line",
      error?.code,
    );
  }
  return toLineDto(data as unknown as Cluster4LineRow, 0, 0);
}

export async function updateCluster4Line(
  id: string,
  input: Cluster4LinePatchInput,
  actorAdminId: string,
): Promise<Cluster4LineDto> {
  if (!isUuid(id)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }

  if (
    input.submissionOpensAt &&
    input.submissionClosesAt &&
    new Date(input.submissionOpensAt).getTime() > new Date(input.submissionClosesAt).getTime()
  ) {
    throw new Cluster4LineError(
      400,
      "submission_opens_at must be earlier than or equal to submission_closes_at",
    );
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .update(linePayload(input, actorAdminId, "update"))
    .eq("id", id)
    .select(LINE_SELECT)
    .maybeSingle();
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
  const { targetCounts, submissionCounts } = await fetchTargetCountsByLineIds([id]);
  return toLineDto(
    data as unknown as Cluster4LineRow,
    targetCounts.get(id) ?? 0,
    submissionCounts.get(id) ?? 0,
  );
}

export async function deleteCluster4Line(id: string): Promise<void> {
  await ensureLineExists(id);
  const { error } = await supabaseAdmin.from("cluster4_lines").delete().eq("id", id);
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
}

export async function listCluster4LineTargets(
  lineId: string,
): Promise<ListCluster4LineTargetsResult> {
  await ensureLineExists(lineId);

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_SELECT)
    .eq("line_id", lineId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }

  const rows = (data ?? []) as unknown as Cluster4LineTargetRow[];
  const submissionCounts = await fetchSubmissionCountsByTargetIds(rows.map((row) => row.id));
  return {
    lineId,
    rows: rows.map((row) => toTargetDto(row, submissionCounts.get(row.id) ?? 0)),
  };
}

export async function createCluster4LineTarget(
  lineId: string,
  input: Cluster4LineTargetCreateInput,
  actorAdminId: string,
): Promise<Cluster4LineTargetDto> {
  await ensureLineExists(lineId);
  await ensureWeekExists(input.weekId);
  if (input.targetMode === "user") {
    await ensureTargetUserExists(input.targetUserId);
  }

  const payload = {
    ...targetPayload(input, actorAdminId, "create"),
    line_id: lineId,
  };

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .insert(payload)
    .select(TARGET_SELECT)
    .single();
  if (error || !data) {
    throw translatePostgrestError(
      error?.message ?? "Failed to create cluster4 line target",
      error?.code,
    );
  }
  return toTargetDto(data as unknown as Cluster4LineTargetRow, 0);
}

export async function updateCluster4LineTarget(
  targetId: string,
  input: Cluster4LineTargetPatchInput,
  actorAdminId: string,
): Promise<Cluster4LineTargetDto> {
  if (!isUuid(targetId)) {
    throw new Cluster4LineError(400, "target id must be a UUID");
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_SELECT)
    .eq("id", targetId)
    .maybeSingle();
  if (existingError) {
    throw new Cluster4LineError(500, existingError.message);
  }
  if (!existing) {
    throw new Cluster4LineError(404, "cluster4 line target not found");
  }

  const existingRow = existing as unknown as Cluster4LineTargetRow;
  const nextMode = input.targetMode ?? existingRow.target_mode;
  const nextWeekId = input.weekId ?? existingRow.week_id;
  const nextUserId =
    input.targetUserId !== undefined ? input.targetUserId : existingRow.target_user_id;
  const nextRule =
    input.targetRule !== undefined ? input.targetRule : existingRow.target_rule ?? {};

  await ensureWeekExists(nextWeekId);
  if (nextMode === "user") {
    if (!nextUserId) {
      throw new Cluster4LineError(400, "target_user_id is required when target_mode='user'");
    }
    await ensureTargetUserExists(nextUserId);
  }

  const payload = targetPayload(
    {
      weekId: nextWeekId,
      targetMode: nextMode,
      targetUserId: nextMode === "user" ? nextUserId : null,
      targetRule: nextMode === "rule" ? nextRule : {},
    },
    actorAdminId,
    "update",
  );

  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .update(payload)
    .eq("id", targetId)
    .select(TARGET_SELECT)
    .maybeSingle();
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line target not found");
  }
  const submissionCounts = await fetchSubmissionCountsByTargetIds([targetId]);
  return toTargetDto(
    data as unknown as Cluster4LineTargetRow,
    submissionCounts.get(targetId) ?? 0,
  );
}

export async function deleteCluster4LineTarget(targetId: string): Promise<void> {
  if (!isUuid(targetId)) {
    throw new Cluster4LineError(400, "target id must be a UUID");
  }
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (existingError) {
    throw new Cluster4LineError(500, existingError.message);
  }
  if (!existing) {
    throw new Cluster4LineError(404, "cluster4 line target not found");
  }
  const { error } = await supabaseAdmin.from("cluster4_line_targets").delete().eq("id", targetId);
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Enriched 라인 listing for the 4허브 admin UI (info/experience/competency/career).
// 활동 유형 탭/검색·필터 운영을 위해 필요한 모든 조인(활동 유형명, 주차 라벨,
// 대상자 이름·조직, 제출 상태, lineTargetId 단위 canEdit)을 한 번에 묶어 돌려준다.
// 기존 listCluster4Lines 는 그대로 유지한다 (append-only).
// ─────────────────────────────────────────────────────────────────────────

export type ListCluster4LinesDetailedOptions = {
  partType?: Cluster4LineDto["partType"] | null;
  weekId?: string | null;
  activityTypeId?: string | null;
  limit?: number;
  offset?: number;
};

export async function listCluster4LinesDetailed(
  options: ListCluster4LinesDetailedOptions = {},
): Promise<ListCluster4LinesDetailedResult> {
  const now = Date.now();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const partType = options.partType ?? null;
  // partType 별 운영자 편집권 override resource_key. partType 미지정 시 info 기준.
  const editWindowKey = partType
    ? PART_TYPE_TO_EDIT_WINDOW_KEY[partType]
    : PART_TYPE_TO_EDIT_WINDOW_KEY.info;

  // 0. weekId 필터: 해당 주차에 target 이 있는 라인 id 만 추린다 (listCluster4Lines 와 동일 전략).
  let lineIdsFilter: string[] | null = null;
  if (options.weekId) {
    if (!isUuid(options.weekId)) {
      throw new Cluster4LineError(400, "week_id must be a UUID");
    }
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("line_id")
      .eq("week_id", options.weekId);
    if (error) throw new Cluster4LineError(500, error.message);
    lineIdsFilter = Array.from(
      new Set(
        ((data ?? []) as Array<{ line_id: string | null }>)
          .map((row) => row.line_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    );
    if (lineIdsFilter.length === 0) return { rows: [], total: 0, limit, offset };
  }

  // 1. 라인 목록.
  let lineQuery = supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_SELECT);
  if (partType) {
    lineQuery = lineQuery.eq("part_type", partType);
  }
  if (options.activityTypeId && options.activityTypeId.trim().length > 0) {
    lineQuery = lineQuery.eq("activity_type_id", options.activityTypeId.trim());
  }
  if (lineIdsFilter) {
    lineQuery = lineQuery.in("id", lineIdsFilter);
  }
  lineQuery = lineQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: lineData, error: lineError } = await lineQuery;
  if (lineError) throw new Cluster4LineError(500, lineError.message);
  const lineRows = (lineData ?? []) as unknown as Cluster4LineRow[];
  if (lineRows.length === 0) return { rows: [], total: 0, limit, offset };

  const lineIds = lineRows.map((row) => row.id);

  // 2. 대상 target 목록.
  const { data: targetData, error: targetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(TARGET_SELECT)
    .in("line_id", lineIds);
  if (targetError) throw new Cluster4LineError(500, targetError.message);
  const targetRows = (targetData ?? []) as unknown as Cluster4LineTargetRow[];
  const targetIds = targetRows.map((row) => row.id);

  // 3. 제출(submission) — line_target_id 단위.
  const submissionByTargetId = new Map<string, { id: string; submittedAt: string | null }>();
  if (targetIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("id,line_target_id,submitted_at")
      .in("line_target_id", targetIds);
    if (error) throw new Cluster4LineError(500, error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      line_target_id: string;
      submitted_at: string | null;
    }>) {
      submissionByTargetId.set(row.line_target_id, {
        id: row.id,
        submittedAt: row.submitted_at,
      });
    }
  }

  // 4. 대상자 이름.
  const userIds = Array.from(
    new Set(
      targetRows
        .map((row) => row.target_user_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  const nameByUserId = new Map<string, string>();
  const orgByUserId = new Map<string, string | null>();
  if (userIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", userIds);
    if (error) throw new Cluster4LineError(500, error.message);
    for (const row of (data ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
    }>) {
      nameByUserId.set(row.user_id, row.display_name ?? "(이름 없음)");
      orgByUserId.set(row.user_id, row.organization_slug ?? null);
    }
  }

  // 5. 활동 유형명.
  const activityTypeIds = Array.from(
    new Set(
      lineRows
        .map((row) => row.activity_type_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  const activityNameById = new Map<string, string>();
  if (activityTypeIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("activity_types")
      .select("id,name")
      .in("id", activityTypeIds);
    if (error) throw new Cluster4LineError(500, error.message);
    for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) {
      activityNameById.set(row.id, row.name ?? row.id);
    }
  }

  // 6. 주차 라벨.
  const weekIds = Array.from(
    new Set(
      targetRows
        .map((row) => row.week_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  const weekLabelById = new Map<string, string>();
  if (weekIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("weeks")
      .select("id,iso_year,iso_week,start_date,end_date")
      .in("id", weekIds);
    if (error) throw new Cluster4LineError(500, error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      iso_year: number | null;
      iso_week: number | null;
      start_date: string | null;
      end_date: string | null;
    }>) {
      const wk =
        row.iso_year && row.iso_week
          ? `${row.iso_year}-W${String(row.iso_week).padStart(2, "0")}`
          : "주차";
      const range =
        row.start_date && row.end_date ? ` (${row.start_date} ~ ${row.end_date})` : "";
      weekLabelById.set(row.id, `${wk}${range}`);
    }
  }

  // 7. 운영자 편집권 override (cluster4.work_info). 테이블 부재 시 무시.
  const overrideByUserId = new Map<string, Cluster4EditWindowSnapshot>();
  if (userIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("user_edit_windows")
      .select("user_id,opened_at,expires_at")
      .eq("resource_key", editWindowKey)
      .in("user_id", userIds);
    if (error) {
      console.warn(
        "[admin/cluster4 info-lines] user_edit_windows lookup failed; treating as no override",
        { message: error.message },
      );
    } else {
      for (const row of (data ?? []) as Array<{
        user_id: string;
        opened_at: string;
        expires_at: string;
      }>) {
        overrideByUserId.set(row.user_id, {
          openedAt: row.opened_at,
          expiresAt: row.expires_at,
        });
      }
    }
  }

  // 8. 라인별 조립.
  const targetsByLineId = new Map<string, Cluster4LineTargetRow[]>();
  for (const target of targetRows) {
    const list = targetsByLineId.get(target.line_id) ?? [];
    list.push(target);
    targetsByLineId.set(target.line_id, list);
  }

  const rows: Cluster4InfoLineDetail[] = lineRows.map((line) => {
    const lineTargets = targetsByLineId.get(line.id) ?? [];
    let submittedCount = 0;
    let canEditCount = 0;

    const targets: Cluster4InfoLineTargetDetail[] = lineTargets.map((target) => {
      const submission = submissionByTargetId.get(target.id) ?? null;
      const submitted = submission != null;
      if (submitted) submittedCount += 1;

      // 강화 상태: 어드민 상세는 target 이 항상 존재(hasTarget=true)하므로
      // 마감 여부로만 success/pending 을 가른다 (마감 후면 미기입이라도 success).
      // submitted 와는 분리된 축.
      const deadlinePassed =
        Boolean(line.submission_closes_at) &&
        now > new Date(line.submission_closes_at).getTime();
      const enhancement = computeCluster4Enhancement({
        hasTarget: true,
        deadlinePassed,
        hasSubmission: submitted,
        isCareer: line.part_type === "career",
      });

      const decision = evaluateCluster4HubEdit({
        target: {
          target_mode: target.target_mode,
          target_user_id: target.target_user_id,
          line: {
            is_active: Boolean(line.is_active),
            submission_opens_at: line.submission_opens_at,
            submission_closes_at: line.submission_closes_at,
          },
        },
        editWindow: target.target_user_id
          ? overrideByUserId.get(target.target_user_id) ?? null
          : null,
        profileUserId: target.target_user_id,
        now,
      });
      if (decision.canEdit) canEditCount += 1;

      return {
        lineTargetId: target.id,
        weekId: target.week_id,
        targetUserId: target.target_user_id,
        displayName: target.target_user_id
          ? nameByUserId.get(target.target_user_id) ?? "(알 수 없음)"
          : "(rule)",
        organizationSlug: target.target_user_id
          ? orgByUserId.get(target.target_user_id) ?? null
          : null,
        targetMode: target.target_mode,
        submissionId: submission?.id ?? null,
        submitted,
        submittedAt: submission?.submittedAt ?? null,
        enhancementStatus: enhancement.enhancementStatus,
        submissionStatus: enhancement.submissionStatus,
        enhancementReason: enhancement.enhancementReason,
        canEdit: decision.canEdit,
        editReason: decision.reason,
      };
    });

    const targetCount = lineTargets.length;
    const weekId = lineTargets[0]?.week_id ?? null;
    const weekLabel = weekId ? weekLabelById.get(weekId) ?? null : null;
    const base = toLineDto(line, targetCount, submittedCount);

    return {
      ...base,
      activityTypeName: line.activity_type_id
        ? activityNameById.get(line.activity_type_id) ?? null
        : null,
      weekId,
      weekLabel,
      submittedCount,
      pendingCount: targetCount - submittedCount,
      canEditCount,
      targets,
    };
  });

  return { rows, total: rows.length, limit, offset };
}

// 실무 정보(part_type='info') 전용 wrapper — 기존 info-lines GET 호환 유지.
export type ListCluster4InfoLinesDetailedOptions = {
  weekId?: string | null;
  activityTypeId?: string | null;
};

export async function listCluster4InfoLinesDetailed(
  options: ListCluster4InfoLinesDetailedOptions = {},
): Promise<ListCluster4InfoLinesDetailedResult> {
  const { rows } = await listCluster4LinesDetailed({
    partType: "info",
    weekId: options.weekId,
    activityTypeId: options.activityTypeId,
  });
  return { rows };
}
