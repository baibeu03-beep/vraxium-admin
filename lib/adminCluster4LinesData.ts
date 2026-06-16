import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import type {
  Cluster4InfoLineDetail,
  Cluster4InfoLineTargetDetail,
  Cluster4LineDto,
  Cluster4LinePatchInput,
  Cluster4LineTargetCreateInput,
  Cluster4LineTargetDto,
  Cluster4LineTargetPatchInput,
  Cluster4LineUpsertInput,
  Cluster4LineWorkflowAction,
  Cluster4LineWorkflowStatus,
  Cluster4OpenedLineDto,
  Cluster4OpenedLineStatus,
  ListCluster4InfoLinesDetailedResult,
  ListCluster4LinesDetailedResult,
  ListCluster4LinesResult,
  ListCluster4LineTargetsResult,
  ListCluster4OpenedLinesResult,
} from "@/lib/adminCluster4LinesTypes";
import { CLUSTER4_HUB_LABEL } from "@/lib/adminCluster4LinesTypes";
import {
  evaluateCluster4HubEdit,
  isEditWindowActive,
  PART_TYPE_TO_EDIT_WINDOW_KEY,
  type Cluster4EditWindowSnapshot,
} from "@/lib/cluster4LinePermission";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import {
  outputImageUrls,
  outputImageCaptions as outputImageCaptionList,
} from "@/lib/cluster4OutputImages";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  isLineVisibleForUserOrg,
  normalizeLineOrg,
  parseLineCodeOrg,
  type LineOrgScope,
} from "@/lib/cluster4LineOrg";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { getRegistrationOrgByBridgedMasterId } from "@/lib/lineRegistrationLookup";

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
  week_id: string | null;
  source_type: string | null;
  recognition_mode: string | null;
  source_sheet_name: string | null;
  is_recurring_content: boolean | null;
  line_code: string | null;
  career_project_id: string | null;
  main_title: string;
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
  // 라인 개설 역할별 진행 상태/담당자 (career 전용, nullable).
  input_completed_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  opened_at: string | null;
  opened_by: string | null;
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
  "id,part_type,activity_type_id,week_id,source_type,recognition_mode,source_sheet_name,is_recurring_content,line_code,career_project_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_by,updated_by,created_at,updated_at,input_completed_at,reviewed_at,reviewed_by,opened_at,opened_by";
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

// 라인 1건의 org 노출 범위(LineOrgScope)를 판정한다 — 고객 weekly-cards 와 동일 정책 단일 출처.
//   line_code 토큰(BS>EC>OK>PX) 우선 → info 는 common → exp/comp 는 정의 organization_slug
//   (line_registrations bridged 역참조 우선, 없으면 기존 마스터 fallback). career/판정불가 → null.
// collectLineOrgAudience(고객 가시성) 와 어드민 라인 목록 org 필터가 이 함수를 공유하므로
// 두 경로의 가시성 정책이 구조적으로 갈라질 수 없다.
export async function resolveCluster4LineOrgScope(row: {
  part_type: string;
  line_code: string | null;
  experience_line_master_id?: string | null;
  competency_line_master_id?: string | null;
}): Promise<LineOrgScope | null> {
  let lineOrg: LineOrgScope | null = parseLineCodeOrg(row.line_code);
  if (lineOrg != null) return lineOrg;
  if (row.part_type === "info") return "common";
  if (row.part_type === "experience" && row.experience_line_master_id) {
    lineOrg = normalizeLineOrg(
      await getRegistrationOrgByBridgedMasterId(row.experience_line_master_id),
    );
    if (lineOrg == null) {
      const { data: m } = await supabaseAdmin
        .from("cluster4_experience_line_masters")
        .select("organization_slug")
        .eq("id", row.experience_line_master_id)
        .maybeSingle();
      lineOrg = normalizeLineOrg(
        (m as { organization_slug: string | null } | null)?.organization_slug,
      );
    }
  } else if (row.part_type === "competency" && row.competency_line_master_id) {
    lineOrg = normalizeLineOrg(
      await getRegistrationOrgByBridgedMasterId(row.competency_line_master_id),
    );
    if (lineOrg == null) {
      const { data: m } = await supabaseAdmin
        .from("cluster4_competency_line_masters")
        .select("organization_slug")
        .eq("id", row.competency_line_master_id)
        .maybeSingle();
      lineOrg = normalizeLineOrg(
        (m as { organization_slug: string | null } | null)?.organization_slug,
      );
    }
  }
  return lineOrg;
}

// 어드민 라인 목록(info/experience/competency)을 현재 조직으로 좁힌다.
// 조직 X 화면 = (lineOrg == X) OR (common). lineOrg 판정 불가 = 숨김(allowUnknown=false, fail-closed)
// — 고객 weekly-cards Step 2 노출 필터와 동일. 반환 = 노출 대상 line id 목록.
// restrictTo 가 주어지면(주차 필터 등) 그 부분집합 안에서만 판정한다.
async function filterLineIdsByOrg(opts: {
  organization: OrganizationSlug;
  partType: Cluster4LineDto["partType"] | null;
  restrictTo: string[] | null;
}): Promise<string[]> {
  let q = supabaseAdmin
    .from("cluster4_lines")
    .select(
      "id,part_type,line_code,experience_line_master_id,competency_line_master_id",
    );
  if (opts.partType) q = q.eq("part_type", opts.partType);
  if (opts.restrictTo) q = q.in("id", opts.restrictTo);
  const { data, error } = await q;
  if (error) throw new Cluster4LineError(500, error.message);
  const candidates = (data ?? []) as Array<{
    id: string;
    part_type: string;
    line_code: string | null;
    experience_line_master_id: string | null;
    competency_line_master_id: string | null;
  }>;
  const visible: string[] = [];
  for (const row of candidates) {
    const lineOrg = await resolveCluster4LineOrgScope(row);
    if (isLineVisibleForUserOrg(lineOrg, opts.organization, { allowUnknown: false })) {
      visible.push(row.id);
    }
  }
  return visible;
}

// 라인 org 노출 대상(=그 라인을 synthetic fail 로 보게 되는 사용자) 집합을 계산한다.
//
// 강화율 분모 A 정책(2026-06-02): info/experience/competency 라인은 "개설(=any target 존재)"만으로
// 그 라인을 볼 수 있는 모든 사용자의 분모를 +1 시킨다(개설 + 본인 미배정 = synthetic fail).
// 따라서 라인 타깃 개설/해제/메타변경 시 "배정 대상자만" 무효화하면, 그 라인을 미배정으로 보게 되는
// 같은 org 사용자들의 snapshot 이 stale 로 남는다(과거 회귀: 신규 competency 라인이 배정자 1명만
// 재계산 → 비배정 org 전원 분모 stale). 이 함수가 그 audience 를 산정한다.
//
// 판정은 weekly-cards Step 2 노출 필터(isLineVisibleForUserOrg, allowUnknown=false)와 동일하게 맞춘다:
//   - lineOrg='common'        → 스냅샷 보유 전원
//   - lineOrg=특정 조직        → 그 조직 사용자(+ org 미상 사용자: userOrg null 이면 항상 노출)
//   - lineOrg=null(판정 불가)   → audience 없음(Step 2 숨김, fail-closed). 배정자(Step 1)는 호출부 union.
//   - career part             → 미선발/미배정 = not_applicable(분모 무변) → org audience 없음(배정자만).
// (2E-3) export — org 판정 등가성 검증 스크립트에서 직접 호출하기 위함. 동작 변경 없음.
export async function collectLineOrgAudience(lineId: string): Promise<string[]> {
  const { data: line } = await supabaseAdmin
    .from("cluster4_lines")
    .select(
      "part_type,line_code,competency_line_master_id,experience_line_master_id",
    )
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return [];
  const row = line as {
    part_type: string;
    line_code: string | null;
    competency_line_master_id: string | null;
    experience_line_master_id: string | null;
  };
  // career: 개설+미배정 = not_applicable → 비배정 분모 무변 → org audience 없음.
  if (row.part_type === "career") return [];

  // org 판정 = resolveCluster4LineOrgScope 단일 출처(어드민 라인 목록 org 필터와 공유).
  const lineOrg = await resolveCluster4LineOrgScope(row);
  // 판정 불가 → Step 2 숨김(fail-closed) → org audience 없음(배정자만 호출부에서 union).
  if (lineOrg == null) return [];

  // 스냅샷 보유 사용자 + org → Step 2 노출 필터(allowUnknown=false)로 audience 산정.
  const { data: snaps } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id");
  const userIds = ((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (userIds.length === 0) return [];

  const orgByUser = new Map<string, OrganizationSlug | null>();
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,organization_slug")
    .in("user_id", userIds);
  for (const p of (profs ?? []) as {
    user_id: string;
    organization_slug: string | null;
  }[]) {
    orgByUser.set(
      p.user_id,
      isOrganizationSlug(p.organization_slug) ? p.organization_slug : null,
    );
  }

  return userIds.filter((uid) =>
    isLineVisibleForUserOrg(lineOrg, orgByUser.get(uid) ?? null),
  );
}

// 라인 단위 변경(타깃 개설/해제/메타변경/라인 삭제)으로 영향받는 전원(org audience + 명시 추가분)을
// 즉시 무효화/재계산한다. 과거에는 배정 대상자만 무효화했으나, 개설된 라인은 org audience 전원의
// 분모 A(synthetic fail)에 반영되므로 audience 전체를 무효화해야 stale 이 생기지 않는다.
// best-effort: invalidateWeeklyCardsForUsers 가 실패를 격리하므로 본 쓰기 요청을 깨뜨리지 않는다.
async function invalidateWeeklyCardsForLineChange(
  lineId: string,
  extraUserIds: Array<string | null | undefined> = [],
): Promise<void> {
  let audience: string[] = [];
  try {
    audience = await collectLineOrgAudience(lineId);
  } catch (e) {
    console.warn("[cluster4/lines] org audience 산정 실패 (배정자만 무효화)", {
      lineId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const ids = [
    ...audience,
    ...extraUserIds.filter((u): u is string => Boolean(u)),
  ];
  await invalidateWeeklyCardsForUsers(ids);
}

// 라인에 연결된 대상자(target_mode='user') + org 노출 audience 의 weekly-card snapshot 을 무효화한다.
// 라인 메타 변경/활성 토글처럼 "라인 단위" 변경이 모든 노출 대상 카드에 영향을 줄 때 사용.
async function invalidateSnapshotsForLineTargets(lineId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  if (error) {
    console.warn("[cluster4/lines] snapshot 재계산용 대상자 조회 실패", {
      lineId,
      message: error.message,
    });
  }
  const assignedIds = (data ?? [])
    .map((r) => (r as { target_user_id: string | null }).target_user_id)
    .filter((u): u is string => Boolean(u));
  // 배정자(Step 1) + org 노출 audience(Step 2) 모두 무효화.
  await invalidateWeeklyCardsForLineChange(lineId, assignedIds);
}

async function fetchLineIdsForWeekFilter(
  weekId: string,
  options: { targetMode?: Cluster4LineTargetDto["targetMode"] | null } = {},
) {
  const lineIds = new Set<string>();

  let targetQuery = supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .eq("week_id", weekId);
  if (options.targetMode) {
    targetQuery = targetQuery.eq("target_mode", options.targetMode);
  }

  const { data: targetRows, error: targetError } = await targetQuery;
  if (targetError) {
    throw new Cluster4LineError(500, targetError.message);
  }
  for (const row of (targetRows ?? []) as Array<{ line_id: string | null }>) {
    if (row.line_id) lineIds.add(row.line_id);
  }

  // Excel-imported lines intentionally have no cluster4_line_targets. Include
  // them by their line-level week_id only when the caller is not specifically
  // asking for a target mode.
  if (!options.targetMode) {
    const { data: lineRows, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("week_id", weekId)
      .eq("source_type", "excel_import");
    if (lineError) {
      throw new Cluster4LineError(500, lineError.message);
    }
    for (const row of (lineRows ?? []) as Array<{ id: string | null }>) {
      if (row.id) lineIds.add(row.id);
    }
  }

  return Array.from(lineIds);
}

export type ListCluster4LinesOptions = {
  partType?: Cluster4LineDto["partType"] | null;
  weekId?: string | null;
  targetMode?: Cluster4LineTargetDto["targetMode"] | null;
  query?: string | null;
  // 조직 스코프(통합 ↔ 조직). null/미지정 = 통합(전체). 지정 시 (lineOrg == organization) OR common.
  organization?: OrganizationSlug | null;
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
    if (options.weekId) {
      lineIdsFilter = await fetchLineIdsForWeekFilter(options.weekId, {
        targetMode: options.targetMode ?? null,
      });
    } else {
      let targetQuery = supabaseAdmin.from("cluster4_line_targets").select("line_id");
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
    }
    if (lineIdsFilter.length === 0) {
      return { rows: [], total: 0, limit, offset };
    }
  }

  // 조직 스코프: org 지정 시 노출 대상 라인 id 로 좁힌다(기존 부분집합과 교집합).
  // org 미지정(통합)이면 미적용 → 기존 쿼리/카운트와 동일.
  if (options.organization) {
    lineIdsFilter = await filterLineIdsByOrg({
      organization: options.organization,
      partType: options.partType ?? null,
      restrictTo: lineIdsFilter,
    });
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
  // 라인 메타(title/output/기입기간/is_active 등) 변경은 모든 대상자 주차 카드에 영향 → 즉시 재계산.
  await invalidateSnapshotsForLineTargets(id);
  const { targetCounts, submissionCounts } = await fetchTargetCountsByLineIds([id]);
  return toLineDto(
    data as unknown as Cluster4LineRow,
    targetCounts.get(id) ?? 0,
    submissionCounts.get(id) ?? 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 라인 개설 [섹션 0] 개설/검수 기록(opening_review_note) — 어드민 전용 자유 텍스트.
//
// 고객 weekly-cards DTO·스냅샷 계산에 일절 참여하지 않는 순수 어드민 메타데이터다.
// 따라서 updateCluster4Line(항상 snapshot 무효화) 을 경유하지 않고, 단일 컬럼만 갱신하며
// invalidateSnapshotsForLineTargets / invalidateWeeklyCardsForUsers 를 **호출하지 않는다**.
// (LINE_SELECT 에도 넣지 않는다 — 기존 목록/계산 경로 무접촉, 컬럼 미적용 상태에서도 안전.)
// ─────────────────────────────────────────────────────────────────────────
export type Cluster4LineOpeningNote = {
  id: string;
  isActive: boolean;
  openingReviewNote: string | null;
};

export async function getCluster4LineOpeningNote(
  id: string,
): Promise<Cluster4LineOpeningNote> {
  if (!isUuid(id)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,is_active,opening_review_note")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
  const row = data as {
    id: string;
    is_active: boolean;
    opening_review_note: string | null;
  };
  return {
    id: row.id,
    isActive: Boolean(row.is_active),
    openingReviewNote: row.opening_review_note ?? null,
  };
}

export async function setCluster4LineOpeningNote(
  id: string,
  note: string | null,
  actorAdminId: string,
): Promise<Cluster4LineOpeningNote> {
  if (!isUuid(id)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }
  // 빈 문자열은 null(기본 문구 표시)로 정규화한다.
  const normalized = typeof note === "string" && note.trim().length > 0 ? note : null;
  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .update({ opening_review_note: normalized, updated_by: actorAdminId })
    .eq("id", id)
    .select("id,is_active,opening_review_note")
    .maybeSingle();
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
  if (!data) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
  // ⚠ snapshot 무효화/재계산 호출 없음 — note 는 고객 DTO 미참조(스냅샷 내용 불변).
  const row = data as {
    id: string;
    is_active: boolean;
    opening_review_note: string | null;
  };
  return {
    id: row.id,
    isActive: Boolean(row.is_active),
    openingReviewNote: row.opening_review_note ?? null,
  };
}

// 라인 개설 진행 상태 — 저장하지 않고 timestamp 조합으로 파생.
function deriveWorkflowStatus(row: {
  input_completed_at: string | null;
  reviewed_at: string | null;
  opened_at: string | null;
}): Cluster4LineWorkflowStatus {
  if (row.opened_at) return "opened";
  if (row.reviewed_at) return "reviewed";
  if (row.input_completed_at) return "input_done";
  return "input_pending";
}

// 역할별 워크플로 단계 처리(파트장 입력완료 / 에이전트 검수완료 / 팀장 개설).
// career 라인 전용. 시간/순서/권한 강제 없음 — 단계 기록만 갱신한다(자기 검수 허용).
export async function setCluster4LineWorkflowStage(
  id: string,
  action: Cluster4LineWorkflowAction,
  actorAdminId: string,
): Promise<Cluster4LineDto> {
  if (!isUuid(id)) {
    throw new Cluster4LineError(400, "line id must be a UUID");
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new Cluster4LineError(500, existingError.message);
  }
  if (!existing) {
    throw new Cluster4LineError(404, "cluster4 line not found");
  }
  if ((existing as { part_type: string }).part_type !== "career") {
    throw new Cluster4LineError(
      400,
      "라인 개설 진행 상태는 실무 경력(career) 라인에서만 사용할 수 있습니다",
    );
  }

  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = { updated_by: actorAdminId };
  switch (action) {
    case "input_complete":
      payload.input_completed_at = nowIso;
      break;
    case "review_complete":
      payload.reviewed_at = nowIso;
      payload.reviewed_by = actorAdminId;
      break;
    case "open":
      payload.opened_at = nowIso;
      payload.opened_by = actorAdminId;
      break;
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_lines")
    .update(payload)
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

// (week_id + activity_type_id) 로 활성 실무 정보 라인 id 를 찾는다(개설 취소용). 없으면 null.
//   라인↔주차 연결: 타깃(week_id, 0명 sentinel 포함) ∪ 라인 자체 week_id. 둘 중 하나라도 매칭.
//   개설 클래시 가드로 (주차+활동유형) 활성 라인은 최대 1개라 첫 매칭을 돌려준다.
// organization 지정 시(org 분기 진입) 그 org 에 노출되는 라인(== org OR common)만 대상으로 한다.
//   다른 조직이 같은 주차+활동유형에 개설한 라인을 잘못 삭제하지 않도록 org 격리(2026-06-16).
//   org 미지정(통합) 이면 종전대로 첫 활성 라인을 반환한다.
export async function findActiveInfoLineId(
  weekId: string,
  activityTypeId: string,
  organization: OrganizationSlug | null = null,
): Promise<string | null> {
  const visibleToOrg = (lineCode: string | null): boolean => {
    if (!organization) return true;
    // info 라인 org = line_code 토큰, 없으면 'common'(resolveCluster4LineOrgScope 와 동일).
    const lineOrg = parseLineCodeOrg(lineCode) ?? "common";
    return isLineVisibleForUserOrg(lineOrg, organization, { allowUnknown: false });
  };

  const { data: tRows, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(
      "line_id,cluster4_lines!inner(activity_type_id,part_type,is_active,line_code)",
    )
    .eq("week_id", weekId)
    .eq("cluster4_lines.is_active", true)
    .eq("cluster4_lines.part_type", "info")
    .eq("cluster4_lines.activity_type_id", activityTypeId);
  if (tErr) throw new Cluster4LineError(500, tErr.message);
  for (const r of (tRows ?? []) as unknown as Array<{
    line_id: string | null;
    // PostgREST 는 임베드 관계를 객체 또는 배열로 표현할 수 있어 둘 다 수용.
    cluster4_lines:
      | { line_code: string | null }
      | Array<{ line_code: string | null }>
      | null;
  }>) {
    const joined = Array.isArray(r.cluster4_lines)
      ? r.cluster4_lines[0]
      : r.cluster4_lines;
    if (r.line_id && visibleToOrg(joined?.line_code ?? null)) {
      return r.line_id;
    }
  }

  // 타깃이 전혀 없는(레거시) 라인 대비 — 라인 자체 week_id 로도 조회.
  const { data: lRows, error: lErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,line_code")
    .eq("part_type", "info")
    .eq("activity_type_id", activityTypeId)
    .eq("week_id", weekId)
    .eq("is_active", true);
  if (lErr) throw new Cluster4LineError(500, lErr.message);
  for (const r of (lRows ?? []) as Array<{ id: string; line_code: string | null }>) {
    if (visibleToOrg(r.line_code)) return r.id;
  }
  return null;
}

export async function deleteCluster4Line(id: string): Promise<void> {
  await ensureLineExists(id);
  // 삭제 전 대상자 + org audience 수집 — FK cascade 로 targets/라인 행이 사라지기 전에 확보.
  //   (collectLineOrgAudience 는 cluster4_lines 행을 읽으므로 반드시 삭제 전에 호출한다.)
  const [{ data: affectedTargets }, orgAudience] = await Promise.all([
    supabaseAdmin
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("line_id", id)
      .eq("target_mode", "user"),
    collectLineOrgAudience(id).catch(() => [] as string[]),
  ]);
  const affectedUserIds = (affectedTargets ?? [])
    .map((r) => (r as { target_user_id: string | null }).target_user_id)
    .filter((u): u is string => Boolean(u));
  const { error } = await supabaseAdmin.from("cluster4_lines").delete().eq("id", id);
  if (error) {
    throw translatePostgrestError(error.message, error.code);
  }
  // 라인 삭제 = 배정자 카드에서 라인 제거 + org audience 의 분모 A(synthetic fail) 제거 →
  // 배정자 + org audience 전원 즉시 재계산(placeholder/분모 복귀 반영).
  await invalidateWeeklyCardsForUsers([...affectedUserIds, ...orgAudience]);
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
  // 라인 타깃 개설은 그 라인을 "개설(any target)"로 만들어 배정자뿐 아니라 같은 org 의
  // 비배정 사용자 분모 A(synthetic fail)까지 바꾼다 → 배정자 + org audience 전원 재계산.
  // (과거: 배정자만 무효화 → 비배정 org 사용자 stale. info/exp/competency 회귀 지점.)
  // invalidateWeeklyCardsForUsers: ≤10명 즉시 recompute / >10명 stale+after 백그라운드. best-effort.
  await invalidateWeeklyCardsForLineChange(
    lineId,
    input.targetMode === "user" ? [input.targetUserId] : [],
  );
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
  // 대상자/주차 변경 → 이전/이후 대상자 + 라인 org audience 모두 즉시 재계산(구조 변경).
  await invalidateWeeklyCardsForLineChange(existingRow.line_id, [
    existingRow.target_user_id,
    nextMode === "user" ? nextUserId : null,
  ]);
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
    .select("id,line_id,target_user_id")
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
  // 타깃 해제는 해제 대상자의 가용 라인을 줄이고, 그것이 그 라인의 마지막 타깃이면 org audience 의
  // 분모 A(synthetic fail)도 사라진다 → 해제 대상자 + 라인 org audience 전원 재계산.
  const removed = existing as { line_id: string; target_user_id: string | null };
  await invalidateWeeklyCardsForLineChange(removed.line_id, [removed.target_user_id]);
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
  // 조직 스코프(통합 검수 시스템 ↔ 조직 진입). null/미지정 = 통합(전체 조직).
  // 지정 시 (lineOrg == organization) OR common 만 노출(고객 가시성과 동일).
  organization?: OrganizationSlug | null;
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
    lineIdsFilter = await fetchLineIdsForWeekFilter(options.weekId);
    if (lineIdsFilter.length === 0) return { rows: [], total: 0, limit, offset };
  }

  // 0b. 조직 스코프: org 지정 시 노출 대상 라인 id 로 좁힌다(weekId 부분집합과 교집합).
  //     org 미지정(통합)이면 미적용 → 기존 쿼리와 동일.
  if (options.organization) {
    lineIdsFilter = await filterLineIdsByOrg({
      organization: options.organization,
      partType,
      restrictTo: lineIdsFilter,
    });
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
  // 어드민 상세는 크루원 제출값(subtitle/growth_point/output_images)을 대상자별 읽기 전용으로
  // 노출한다. (구 cluster4_lines.info_* 운영자 입력 → deprecated. 제출값으로 이전됨.)
  const submissionByTargetId = new Map<
    string,
    {
      id: string;
      submittedAt: string | null;
      subtitle: string | null;
      growthPoint: string | null;
      outputImages: string[];
    }
  >();
  if (targetIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("id,line_target_id,submitted_at,subtitle,growth_point,output_images")
      .in("line_target_id", targetIds);
    if (error) throw new Cluster4LineError(500, error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      line_target_id: string;
      submitted_at: string | null;
      subtitle: string | null;
      growth_point: string | null;
      output_images: unknown;
    }>) {
      submissionByTargetId.set(row.line_target_id, {
        id: row.id,
        submittedAt: row.submitted_at,
        subtitle: row.subtitle ?? null,
        growthPoint: row.growth_point ?? null,
        outputImages: outputImageUrls(row.output_images),
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
      [
        ...targetRows.map((row) => row.week_id),
        ...lineRows.map((row) => row.week_id),
      ]
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

  // 7. 운영자 편집권 override (cluster4.work_*). 테이블 부재 시 무시.
  //    2026-06-08 주차별 추가 개방: 사용자별로 주차 행(byWeek) + 전역(week_id=NULL) 행을
  //    분리 보관하고, 라인 평가 시 (그 라인 주차 OR 전역) additive OR 로 active 한 것을 고른다.
  type OverrideEntry = {
    byWeek: Map<string, Cluster4EditWindowSnapshot>;
    global: Cluster4EditWindowSnapshot;
  };
  const overrideByUserId = new Map<string, OverrideEntry>();
  if (userIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("user_edit_windows")
      .select("user_id,week_id,opened_at,expires_at")
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
        week_id: string | null;
        opened_at: string;
        expires_at: string;
      }>) {
        let entry = overrideByUserId.get(row.user_id);
        if (!entry) {
          entry = { byWeek: new Map(), global: null };
          overrideByUserId.set(row.user_id, entry);
        }
        const snap: Cluster4EditWindowSnapshot = {
          openedAt: row.opened_at,
          expiresAt: row.expires_at,
        };
        if (row.week_id) entry.byWeek.set(row.week_id, snap);
        else entry.global = snap;
      }
    }
  }

  // (userId, lineWeekId) 에 적용할 override 를 active 우선으로 고른다 (weekly-cards 와 동일 정책).
  const resolveOverride = (
    userId: string | null,
    weekId: string | null,
  ): Cluster4EditWindowSnapshot => {
    if (!userId) return null;
    const entry = overrideByUserId.get(userId);
    if (!entry) return null;
    const wk = weekId ? entry.byWeek.get(weekId) ?? null : null;
    if (wk && isEditWindowActive(wk, now)) return wk;
    if (entry.global && isEditWindowActive(entry.global, now)) return entry.global;
    return null;
  };

  // 7.5 career 라인 sponsor-card 메타 (career_project_id → career_projects 6필드) 일괄 룩업.
  // source = career_projects (companyName 은 company_name 기준, supervisor_company fallback 미사용 —
  // weekly-cards DTO 와 동일 SoT). career part 라인에만 매핑하고 그 외/미연결은 null.
  // 조회 실패해도 라인 목록을 깨뜨리지 않고 메타만 null 폴백한다.
  type CareerLineMeta = {
    companyName: string | null;
    companyLogoUrl: string | null;
    supervisorName: string | null;
    supervisorDepartment: string | null;
    supervisorPosition: string | null;
    supervisorPhotoUrl: string | null;
  };
  const careerMetaByProjectId = new Map<string, CareerLineMeta>();
  const careerProjectIds = Array.from(
    new Set(
      lineRows
        .filter((row) => row.part_type === "career")
        .map((row) => row.career_project_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  if (careerProjectIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("career_projects")
      .select(
        "id,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img",
      )
      .in("id", careerProjectIds);
    if (error) {
      console.warn(
        "[admin/cluster4 lines] career_projects meta lookup failed; treating as null",
        { message: error.message },
      );
    } else {
      for (const row of (data ?? []) as Array<{
        id: string;
        company_name: string | null;
        company_logo_url: string | null;
        supervisor_name: string | null;
        supervisor_department: string | null;
        supervisor_position: string | null;
        supervisor_profile_img: string | null;
      }>) {
        careerMetaByProjectId.set(row.id, {
          companyName: row.company_name ?? null,
          companyLogoUrl: row.company_logo_url ?? null,
          supervisorName: row.supervisor_name ?? null,
          supervisorDepartment: row.supervisor_department ?? null,
          supervisorPosition: row.supervisor_position ?? null,
          supervisorPhotoUrl: row.supervisor_profile_img ?? null,
        });
      }
    }
  }

  // 7.6 라인 개설 담당자(created_by=입력자 / reviewed_by=검수자 / opened_by=개설자) 이름 일괄 룩업.
  // admin_users 에 display name 컬럼이 없어 email 을 표시값으로 사용한다.
  // career 라인에만 의미가 있으므로 career 라인의 3개 admin id 만 모은다.
  // 조회 실패해도 목록을 깨뜨리지 않고 이름만 null 폴백.
  const adminEmailById = new Map<string, string>();
  const workflowAdminIds = Array.from(
    new Set(
      lineRows
        .filter((row) => row.part_type === "career")
        .flatMap((row) => [row.created_by, row.reviewed_by, row.opened_by])
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  if (workflowAdminIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("admin_users")
      .select("id,email")
      .in("id", workflowAdminIds);
    if (error) {
      console.warn(
        "[admin/cluster4 lines] admin_users name lookup failed; treating as null",
        { message: error.message },
      );
    } else {
      for (const row of (data ?? []) as Array<{ id: string; email: string | null }>) {
        if (row.email) adminEmailById.set(row.id, row.email);
      }
    }
  }

  // 8. 라인별 조립.
  //    0명 개설 sentinel(rule-mode, target_rule.zeroTargetOpen)은 실제 대상자가 아니므로
  //    어드민 대상자 목록/카운트에서 제외한다(고객 스냅샷 openedByWeek 에는 그대로 쓰인다).
  const targetsByLineId = new Map<string, Cluster4LineTargetRow[]>();
  for (const target of targetRows) {
    if (target.target_mode === "rule" && target.target_rule?.zeroTargetOpen === true) continue;
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
        editWindow: resolveOverride(target.target_user_id, target.week_id),
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
        // 크루원 제출값 — 읽기 전용 표시용. 미제출이면 null/[].
        subtitle: submission?.subtitle ?? null,
        growthPoint: submission?.growthPoint ?? null,
        outputImages: submission?.outputImages ?? [],
        enhancementStatus: enhancement.enhancementStatus,
        submissionStatus: enhancement.submissionStatus,
        enhancementReason: enhancement.enhancementReason,
        canEdit: decision.canEdit,
        editReason: decision.reason,
      };
    });

    const targetCount = lineTargets.length;
    const weekId = line.week_id ?? lineTargets[0]?.week_id ?? null;
    const weekLabel = weekId ? weekLabelById.get(weekId) ?? null : null;
    const base = toLineDto(line, targetCount, submittedCount);

    // career part 만 sponsor-card 메타 + 라인 개설 워크플로 필드를 채운다.
    const isCareer = line.part_type === "career";
    const careerProjectId = isCareer ? line.career_project_id ?? null : null;
    const careerMeta = careerProjectId
      ? careerMetaByProjectId.get(careerProjectId) ?? null
      : null;

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
      careerProjectId,
      companyName: careerMeta?.companyName ?? null,
      companyLogoUrl: careerMeta?.companyLogoUrl ?? null,
      supervisorName: careerMeta?.supervisorName ?? null,
      supervisorDepartment: careerMeta?.supervisorDepartment ?? null,
      supervisorPosition: careerMeta?.supervisorPosition ?? null,
      supervisorPhotoUrl: careerMeta?.supervisorPhotoUrl ?? null,
      // 라인 개설 역할별 진행 상태/담당자 — career 라인에만 채우고 그 외는 null/input_pending.
      inputCompletedAt: isCareer ? line.input_completed_at ?? null : null,
      reviewedAt: isCareer ? line.reviewed_at ?? null : null,
      reviewedBy: isCareer ? line.reviewed_by ?? null : null,
      reviewedByName:
        isCareer && line.reviewed_by ? adminEmailById.get(line.reviewed_by) ?? null : null,
      openedAt: isCareer ? line.opened_at ?? null : null,
      openedBy: isCareer ? line.opened_by ?? null : null,
      openedByName:
        isCareer && line.opened_by ? adminEmailById.get(line.opened_by) ?? null : null,
      createdByName:
        isCareer && line.created_by ? adminEmailById.get(line.created_by) ?? null : null,
      workflowStatus: isCareer ? deriveWorkflowStatus(line) : "input_pending",
    };
  });

  return { rows, total: rows.length, limit, offset };
}

// 실무 정보(part_type='info') 전용 wrapper — 기존 info-lines GET 호환 유지.
export type ListCluster4InfoLinesDetailedOptions = {
  weekId?: string | null;
  activityTypeId?: string | null;
  // 조직 스코프. null/미지정 = 통합(전체). 지정 시 (lineOrg == organization) OR common.
  // info 라인은 코드 토큰이 없으면 common 으로 귀속되므로, 조직 화면에서도 공통 info 는 노출된다.
  organization?: OrganizationSlug | null;
};

export async function listCluster4InfoLinesDetailed(
  options: ListCluster4InfoLinesDetailedOptions = {},
): Promise<ListCluster4InfoLinesDetailedResult> {
  const { rows } = await listCluster4LinesDetailed({
    partType: "info",
    weekId: options.weekId,
    activityTypeId: options.activityTypeId,
    organization: options.organization,
  });
  return { rows };
}

// ─────────────────────────────────────────────────────────────────────────
// 라인 개설 이력 listing (과거/현재/전체) — /admin/line-opening "개설 이력" + history API 전용.
//
// 단순 DB 조회다. weekly-cards 스냅샷을 읽지도 쓰지도 않으며(SoT 무관) 재계산을 트리거하지 않는다.
// (대상자/조직 노출/강화율 같은 파생값을 다루지 않고, 라인 메타 + 주차/시즌 라벨 + 집계 카운트만 본다.)
//
// status 판정: 기입 마감(submission_closes_at) 대비 현재시각.
//   past = closes_at < now / current = closes_at >= now (DB where 절로 직접 필터 가능).
// 시즌 필터(seasonKey): 라인은 시즌 컬럼이 없으므로 그 시즌의 weeks 를 먼저 구하고,
//   (a) 그 주차를 가리키는 target 의 line_id + (b) 라인 자신의 week_id 가 그 주차인 라인 으로 후보를 좁힌다.
// ─────────────────────────────────────────────────────────────────────────

export type ListCluster4OpenedLinesOptions = {
  status?: Cluster4OpenedLineStatus | "all" | null;
  partType?: Cluster4LineDto["partType"] | null;
  activityTypeId?: string | null;
  seasonKey?: string | null;
  query?: string | null;
  limit?: number;
  offset?: number;
};

// seasonKey → 그 시즌에 속한 라인 id 집합. (target.week_id ∈ 시즌주차) ∪ (line.week_id ∈ 시즌주차).
async function fetchLineIdsForSeasonFilter(seasonKey: string): Promise<string[]> {
  const { data: weekRows, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("season_key", seasonKey);
  if (weekError) {
    throw new Cluster4LineError(500, weekError.message);
  }
  const weekIds = ((weekRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (weekIds.length === 0) return [];

  const lineIds = new Set<string>();

  const { data: targetRows, error: targetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .in("week_id", weekIds);
  if (targetError) {
    throw new Cluster4LineError(500, targetError.message);
  }
  for (const row of (targetRows ?? []) as Array<{ line_id: string | null }>) {
    if (row.line_id) lineIds.add(row.line_id);
  }

  const { data: lineRows, error: lineError } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .in("week_id", weekIds);
  if (lineError) {
    throw new Cluster4LineError(500, lineError.message);
  }
  for (const row of (lineRows ?? []) as Array<{ id: string | null }>) {
    if (row.id) lineIds.add(row.id);
  }

  return Array.from(lineIds);
}

export async function listCluster4OpenedLines(
  options: ListCluster4OpenedLinesOptions = {},
): Promise<ListCluster4OpenedLinesResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const status = options.status ?? "all";

  // 0. seasonKey 필터 → 후보 라인 id 집합.
  let lineIdsFilter: string[] | null = null;
  if (options.seasonKey && options.seasonKey.trim().length > 0) {
    lineIdsFilter = await fetchLineIdsForSeasonFilter(options.seasonKey.trim());
    if (lineIdsFilter.length === 0) return { rows: [], total: 0, limit, offset };
  }

  // 1. 라인 목록(메타) — cluster4_lines 단일 SELECT + 카운트.
  let queryBuilder = supabaseAdmin
    .from("cluster4_lines")
    .select(LINE_SELECT, { count: "exact" });

  if (options.partType) {
    queryBuilder = queryBuilder.eq("part_type", options.partType);
  }
  if (options.activityTypeId && options.activityTypeId.trim().length > 0) {
    queryBuilder = queryBuilder.eq("activity_type_id", options.activityTypeId.trim());
  }
  if (status === "past") {
    queryBuilder = queryBuilder.lt("submission_closes_at", nowIso);
  } else if (status === "current") {
    queryBuilder = queryBuilder.gte("submission_closes_at", nowIso);
  }
  if (lineIdsFilter) {
    queryBuilder = queryBuilder.in("id", lineIdsFilter);
  }

  const rawQuery = options.query?.trim() ?? "";
  if (rawQuery.length > 0) {
    const escaped = escapeForIlike(rawQuery);
    if (escaped.length > 0) {
      const filters = [`main_title.ilike.%${escaped}%`];
      if (isUuid(rawQuery)) filters.push(`id.eq.${rawQuery}`);
      queryBuilder = queryBuilder.or(filters.join(","));
    } else if (isUuid(rawQuery)) {
      queryBuilder = queryBuilder.eq("id", rawQuery);
    }
  }

  // 기본 정렬: 기입 시작일(startDate) desc → 생성일 desc → id (안정 정렬).
  queryBuilder = queryBuilder
    .order("submission_opens_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    throw new Cluster4LineError(500, error.message);
  }
  const lineRows = (data ?? []) as unknown as Cluster4LineRow[];
  if (lineRows.length === 0) return { rows: [], total: count ?? 0, limit, offset };

  const lineIds = lineRows.map((row) => row.id);

  // 2. target → 라인별 대상 수 + 주차 후보(week_id) + target id (제출 카운트용).
  const targetCountByLine = new Map<string, number>();
  const weekIdsByLine = new Map<string, Set<string>>();
  const targetIdToLineId = new Map<string, string>();
  {
    const { data: targetRows, error: targetError } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id")
      .in("line_id", lineIds);
    if (targetError) {
      throw new Cluster4LineError(500, targetError.message);
    }
    for (const row of (targetRows ?? []) as Array<{
      id: string;
      line_id: string;
      week_id: string | null;
    }>) {
      targetCountByLine.set(row.line_id, (targetCountByLine.get(row.line_id) ?? 0) + 1);
      targetIdToLineId.set(row.id, row.line_id);
      if (row.week_id) {
        const set = weekIdsByLine.get(row.line_id) ?? new Set<string>();
        set.add(row.week_id);
        weekIdsByLine.set(row.line_id, set);
      }
    }
  }
  // 라인 자신의 week_id(엑셀 import 라인)도 주차 후보에 포함.
  for (const line of lineRows) {
    if (line.week_id) {
      const set = weekIdsByLine.get(line.id) ?? new Set<string>();
      set.add(line.week_id);
      weekIdsByLine.set(line.id, set);
    }
  }

  // 3. 제출 수 — line_target_id → line_id 로 집계.
  const submissionCountByLine = new Map<string, number>();
  const allTargetIds = Array.from(targetIdToLineId.keys());
  if (allTargetIds.length > 0) {
    const { data: subRows, error: subError } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("line_target_id")
      .in("line_target_id", allTargetIds);
    if (subError) {
      throw new Cluster4LineError(500, subError.message);
    }
    for (const row of (subRows ?? []) as Cluster4SubmissionCountRow[]) {
      const lineId = targetIdToLineId.get(row.line_target_id);
      if (!lineId) continue;
      submissionCountByLine.set(lineId, (submissionCountByLine.get(lineId) ?? 0) + 1);
    }
  }

  // 4. weeks 룩업 — 주차 라벨 + season_key + week_number + 시작일(대표 주차 선정용).
  const allWeekIds = Array.from(
    new Set(Array.from(weekIdsByLine.values()).flatMap((set) => Array.from(set))),
  );
  type WeekMeta = {
    seasonKey: string | null;
    weekNumber: number | null;
    startDate: string | null;
    endDate: string | null;
  };
  const weekMetaById = new Map<string, WeekMeta>();
  if (allWeekIds.length > 0) {
    const { data: weeksData, error: weeksError } = await supabaseAdmin
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date")
      .in("id", allWeekIds);
    if (weeksError) {
      throw new Cluster4LineError(500, weeksError.message);
    }
    for (const row of (weeksData ?? []) as Array<{
      id: string;
      season_key: string | null;
      week_number: number | null;
      start_date: string | null;
      end_date: string | null;
    }>) {
      weekMetaById.set(row.id, {
        seasonKey: row.season_key,
        weekNumber: row.week_number,
        startDate: row.start_date,
        endDate: row.end_date,
      });
    }
  }

  // 5. season_definitions 룩업 — season_key → 한글 시즌명(season_label).
  const seasonKeys = Array.from(
    new Set(
      Array.from(weekMetaById.values())
        .map((w) => w.seasonKey)
        .filter((v): v is string => typeof v === "string"),
    ),
  );
  const seasonNameByKey = new Map<string, string>();
  if (seasonKeys.length > 0) {
    const { data: seasonData, error: seasonError } = await supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label")
      .in("season_key", seasonKeys);
    if (seasonError) {
      console.warn(
        "[admin/cluster4 history] season_definitions lookup failed; falling back to season_key",
        { message: seasonError.message },
      );
    } else {
      for (const row of (seasonData ?? []) as Array<{
        season_key: string;
        season_label: string | null;
      }>) {
        if (row.season_label) seasonNameByKey.set(row.season_key, row.season_label);
      }
    }
  }

  // 6. activity_types 룩업 — categoryName.
  const activityTypeIds = Array.from(
    new Set(
      lineRows
        .map((row) => row.activity_type_id)
        .filter((v): v is string => typeof v === "string"),
    ),
  );
  const activityNameById = new Map<string, string>();
  if (activityTypeIds.length > 0) {
    const { data: actData, error: actError } = await supabaseAdmin
      .from("activity_types")
      .select("id,name")
      .in("id", activityTypeIds);
    if (actError) {
      throw new Cluster4LineError(500, actError.message);
    }
    for (const row of (actData ?? []) as Array<{ id: string; name: string | null }>) {
      activityNameById.set(row.id, row.name ?? row.id);
    }
  }

  // 7. 조립. 라인별 대표 주차 = 후보 중 start_date 가장 이른 주차(결정적).
  const rows: Cluster4OpenedLineDto[] = lineRows.map((line) => {
    const candidateWeekIds = Array.from(weekIdsByLine.get(line.id) ?? []);
    let repWeekId: string | null = null;
    let repWeek: WeekMeta | null = null;
    for (const wid of candidateWeekIds) {
      const meta = weekMetaById.get(wid);
      if (!meta) continue;
      if (
        repWeek == null ||
        (meta.startDate ?? "") < (repWeek.startDate ?? "") ||
        // start_date 동률/미상이면 첫 주차 유지
        (repWeekId == null && meta.startDate == null)
      ) {
        repWeek = meta;
        repWeekId = wid;
      }
    }

    const seasonKey = repWeek?.seasonKey ?? null;
    const seasonName = seasonKey
      ? seasonNameByKey.get(seasonKey) ?? seasonKey
      : null;
    const weekNumber = repWeek?.weekNumber ?? null;
    const weekLabel =
      seasonName != null && weekNumber != null
        ? `${seasonName} ${weekNumber}주차`
        : seasonName ?? null;

    const closesMs = line.submission_closes_at
      ? new Date(line.submission_closes_at).getTime()
      : null;
    const status: Cluster4OpenedLineStatus =
      closesMs != null && now > closesMs ? "past" : "current";

    return {
      id: line.id,
      partType: line.part_type,
      hubName: CLUSTER4_HUB_LABEL[line.part_type] ?? line.part_type,
      categoryName: line.activity_type_id
        ? activityNameById.get(line.activity_type_id) ?? null
        : null,
      activityTypeId: line.activity_type_id ?? null,
      lineCode: line.line_code ?? null,
      lineName: line.main_title,
      seasonKey,
      seasonName,
      weekId: repWeekId,
      weekNumber,
      weekLabel,
      startDate: line.submission_opens_at,
      endDate: line.submission_closes_at,
      status,
      isActive: Boolean(line.is_active),
      openedAt: line.part_type === "career" ? line.opened_at ?? null : null,
      targetCount: targetCountByLine.get(line.id) ?? 0,
      submissionCount: submissionCountByLine.get(line.id) ?? 0,
      createdAt: line.created_at,
    };
  });

  return { rows, total: count ?? rows.length, limit, offset };
}
