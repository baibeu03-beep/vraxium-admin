// Browser-safe constants and types for the cluster4 line opening admin APIs.
// Must not import server-only modules here.

import type { Cluster4HubEditDecisionReason } from "@/lib/cluster4LinePermission";
import type {
  Cluster4EnhancementReason,
  Cluster4EnhancementStatus,
  Cluster4SubmissionStatus,
} from "@/shared/cluster4.contracts";
import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";

export type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";

export type Cluster4LinePartType =
  | "info"
  | "experience"
  | "competency"
  | "career";

export type Cluster4LineTargetMode = "user" | "rule";

export type Cluster4LineDto = {
  id: string;
  partType: Cluster4LinePartType;
  activityTypeId: string | null;
  lineCode: string | null;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputLinks: Cluster4OutputLink[];
  outputImages: string[];
  // outputImages 와 index 정렬 일치하는 이미지 캡션. 캡션 없으면 null. (append-only)
  outputImageCaptions: (string | null)[];
  submissionOpensAt: string;
  submissionClosesAt: string;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  targetCount: number;
  submissionCount: number;
};

export type Cluster4LineTargetDto = {
  id: string;
  lineId: string;
  weekId: string;
  targetMode: Cluster4LineTargetMode;
  targetUserId: string | null;
  targetRule: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  submissionCount: number;
};

export type ListCluster4LinesResult = {
  rows: Cluster4LineDto[];
  total: number;
  limit: number;
  offset: number;
};

export type ListCluster4LineTargetsResult = {
  lineId: string;
  rows: Cluster4LineTargetDto[];
};

// ─────────────────────────────────────────────────────────────────────────
// Enriched info-line listing — append-only DTOs for the 실무 정보 admin UI.
// Extends Cluster4LineDto (no field removed) with the joins the operator needs
// to manage lines per activity-type tab: activity/week labels, per-target
// names + submission status + lineTargetId-level canEdit.
// ─────────────────────────────────────────────────────────────────────────

export type Cluster4InfoLineTargetDetail = {
  lineTargetId: string;
  weekId: string;
  targetUserId: string | null;
  displayName: string;
  organizationSlug: string | null;
  targetMode: Cluster4LineTargetMode;
  submissionId: string | null;
  submitted: boolean;
  submittedAt: string | null;
  // 크루원 제출값 — 어드민 상세 읽기 전용 표시용. 미제출이면 null/[].
  // (구 cluster4_lines.info_subtitle/info_growth_point → cluster4_line_submissions 로 이전)
  subtitle: string | null;
  growthPoint: string | null;
  outputImages: string[];
  // 강화 상태 — 서버 계산값(재계산 금지). 어드민 상세는 target 이 항상 존재하므로
  // 마감 여부에 따라 success/pending 으로만 산정된다 (마감 후면 미기입이라도 success).
  // submitted 와 분리된 축이다.
  enhancementStatus: Cluster4EnhancementStatus;
  submissionStatus: Cluster4SubmissionStatus;
  enhancementReason: Cluster4EnhancementReason;
  // lineTargetId 단위 편집 가능 여부 — 프론트 canEdit(evaluateCluster4HubEdit)와 동일 기준.
  canEdit: boolean;
  editReason: Cluster4HubEditDecisionReason;
};

export type Cluster4InfoLineDetail = Cluster4LineDto & {
  activityTypeName: string | null;
  weekId: string | null;
  weekLabel: string | null;
  submittedCount: number;
  pendingCount: number;
  canEditCount: number;
  targets: Cluster4InfoLineTargetDetail[];
};

export type ListCluster4InfoLinesDetailedResult = {
  rows: Cluster4InfoLineDetail[];
};

// 4허브 공통(info/experience/competency/career) enriched 라인/대상 타입 별칭.
// Cluster4InfoLineDetail 은 info 전용이 아니라 partType 무관 공통 shape 이므로
// 가독성을 위해 일반 이름으로도 노출한다.
export type Cluster4LineTargetDetail2 = Cluster4InfoLineTargetDetail;
export type Cluster4LineDetail = Cluster4InfoLineDetail;
export type ListCluster4LinesDetailedResult = {
  rows: Cluster4LineDetail[];
  total: number;
  limit: number;
  offset: number;
};

export type Cluster4LineUpsertInput = {
  partType: Cluster4LinePartType;
  activityTypeId: string | null;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputLinks: Cluster4OutputLink[];
  outputImages: string[];
  submissionOpensAt: string;
  submissionClosesAt: string;
  isActive: boolean;
};

export type Cluster4LinePatchInput = Partial<Cluster4LineUpsertInput>;

export type Cluster4LineTargetCreateInput =
  | {
      weekId: string;
      targetMode: "user";
      targetUserId: string;
      targetRule: Record<string, never>;
    }
  | {
      weekId: string;
      targetMode: "rule";
      targetUserId: null;
      targetRule: Record<string, unknown>;
    };

export type Cluster4LineTargetPatchInput = Partial<{
  weekId: string;
  targetMode: Cluster4LineTargetMode;
  targetUserId: string | null;
  targetRule: Record<string, unknown>;
}>;

export const CLUSTER4_LINE_WRITE_ROLES = ["owner"] as const;

export type ParseBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

const PART_TYPES = ["info", "experience", "competency", "career"] as const;
const TARGET_MODES = ["user", "rule"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPartType(value: unknown): value is Cluster4LinePartType {
  return typeof value === "string" && PART_TYPES.includes(value as Cluster4LinePartType);
}

function isTargetMode(value: unknown): value is Cluster4LineTargetMode {
  return typeof value === "string" && TARGET_MODES.includes(value as Cluster4LineTargetMode);
}

function normalizeTextField(
  raw: unknown,
  field: string,
  { required }: { required: boolean },
): ParseBodyResult<string | null> {
  if (raw === undefined || raw === null) {
    if (required) {
      return { ok: false, status: 400, error: `${field} is required` };
    }
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (required && trimmed.length === 0) {
    return { ok: false, status: 400, error: `${field} must not be empty` };
  }
  return { ok: true, value: trimmed.length ? trimmed : null };
}

function normalizeBooleanField(
  raw: unknown,
  field: string,
  { required }: { required: boolean },
): ParseBodyResult<boolean | undefined> {
  if (raw === undefined) {
    return required
      ? { ok: false, status: 400, error: `${field} is required` }
      : { ok: true, value: undefined };
  }
  if (typeof raw !== "boolean") {
    return { ok: false, status: 400, error: `${field} must be a boolean` };
  }
  return { ok: true, value: raw };
}

function normalizeIsoDatetimeField(
  raw: unknown,
  field: string,
  { required }: { required: boolean },
): ParseBodyResult<string | undefined> {
  if (raw === undefined || raw === null) {
    return required
      ? { ok: false, status: 400, error: `${field} is required` }
      : { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: `${field} must be an ISO datetime string` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return required
      ? { ok: false, status: 400, error: `${field} must not be empty` }
      : { ok: true, value: undefined };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, status: 400, error: `${field} must be a valid datetime` };
  }
  return { ok: true, value: parsed.toISOString() };
}

function normalizeRule(raw: unknown): ParseBodyResult<Record<string, unknown>> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (!isRecord(raw)) {
    return { ok: false, status: 400, error: "target_rule must be an object" };
  }
  return { ok: true, value: raw };
}

function normalizeStringArray(
  raw: unknown,
  field: string,
): ParseBodyResult<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, error: `${field} must be an array of strings` };
  }
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, status: 400, error: `${field} items must be strings` };
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) result.push(trimmed);
  }
  return { ok: true, value: result };
}

export function parseCluster4LineCreateBody(body: unknown): ParseBodyResult<Cluster4LineUpsertInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  if (!isPartType(body.part_type)) {
    return { ok: false, status: 400, error: "part_type must be one of info|experience|competency|career" };
  }
  const activityTypeId = normalizeTextField(body.activity_type_id, "activity_type_id", { required: false });
  if (!activityTypeId.ok) return activityTypeId as ParseBodyResult<Cluster4LineUpsertInput>;
  const mainTitle = normalizeTextField(body.main_title, "main_title", { required: true });
  if (!mainTitle.ok || !mainTitle.value) return mainTitle as ParseBodyResult<Cluster4LineUpsertInput>;
  const outputLink1 = normalizeTextField(body.output_link_1, "output_link_1", { required: false });
  if (!outputLink1.ok) return outputLink1 as ParseBodyResult<Cluster4LineUpsertInput>;
  const outputLink2 = normalizeTextField(body.output_link_2, "output_link_2", { required: false });
  if (!outputLink2.ok) return outputLink2 as ParseBodyResult<Cluster4LineUpsertInput>;
  const outputImages = normalizeStringArray(body.output_images, "output_images");
  if (!outputImages.ok) return outputImages as ParseBodyResult<Cluster4LineUpsertInput>;
  const opensAt = normalizeIsoDatetimeField(body.submission_opens_at, "submission_opens_at", { required: true });
  if (!opensAt.ok || !opensAt.value) return opensAt as ParseBodyResult<Cluster4LineUpsertInput>;
  const closesAt = normalizeIsoDatetimeField(body.submission_closes_at, "submission_closes_at", { required: true });
  if (!closesAt.ok || !closesAt.value) return closesAt as ParseBodyResult<Cluster4LineUpsertInput>;
  const isActive = normalizeBooleanField(body.is_active, "is_active", { required: false });
  if (!isActive.ok) return isActive as ParseBodyResult<Cluster4LineUpsertInput>;

  // output_links 우선. 미제공 시 레거시 output_link_1/2 로부터 파생. 라인은 슬롯 2개.
  const parsedLinks = parseOutputLinksInput(body.output_links, { maxLinks: 2 });
  if (!parsedLinks.ok) return { ok: false, status: 400, error: parsedLinks.error };
  const outputLinks =
    parsedLinks.value.length > 0
      ? parsedLinks.value
      : outputLinksFromLegacy([outputLink1.value ?? null, outputLink2.value ?? null]);
  // 레거시 컬럼은 항상 output_links 로부터 mirror (backward compatibility).
  const [mirror1, mirror2] = outputLinksToLegacySlots(outputLinks, 2);

  if (new Date(opensAt.value).getTime() > new Date(closesAt.value).getTime()) {
    return {
      ok: false,
      status: 400,
      error: "submission_opens_at must be earlier than or equal to submission_closes_at",
    };
  }

  return {
    ok: true,
    value: {
      partType: body.part_type,
      activityTypeId: activityTypeId.value ?? null,
      mainTitle: mainTitle.value,
      outputLink1: mirror1,
      outputLink2: mirror2,
      outputLinks,
      outputImages: outputImages.value,
      submissionOpensAt: opensAt.value,
      submissionClosesAt: closesAt.value,
      isActive: isActive.value ?? true,
    },
  };
}

export function parseCluster4LinePatchBody(body: unknown): ParseBodyResult<Cluster4LinePatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const patch: Cluster4LinePatchInput = {};

  if (body.part_type !== undefined) {
    if (!isPartType(body.part_type)) {
      return { ok: false, status: 400, error: "part_type must be one of info|experience|competency|career" };
    }
    patch.partType = body.part_type;
  }

  if (body.activity_type_id !== undefined) {
    const result = normalizeTextField(body.activity_type_id, "activity_type_id", { required: false });
    if (!result.ok) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.activityTypeId = result.value ?? null;
  }

  if (body.main_title !== undefined) {
    const result = normalizeTextField(body.main_title, "main_title", { required: true });
    if (!result.ok || !result.value) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.mainTitle = result.value;
  }

  let legacyLinkProvided = false;
  if (body.output_link_1 !== undefined) {
    const result = normalizeTextField(body.output_link_1, "output_link_1", { required: false });
    if (!result.ok) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.outputLink1 = result.value ?? null;
    legacyLinkProvided = true;
  }

  if (body.output_link_2 !== undefined) {
    const result = normalizeTextField(body.output_link_2, "output_link_2", { required: false });
    if (!result.ok) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.outputLink2 = result.value ?? null;
    legacyLinkProvided = true;
  }

  // output_links 가 오면 canonical 로 채택하고 레거시 컬럼에 mirror.
  // 반대로 레거시 링크만 오면 output_links 도 동기화하여 두 표현을 일치시킨다.
  if (body.output_links !== undefined) {
    const result = parseOutputLinksInput(body.output_links, { maxLinks: 2 });
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    patch.outputLinks = result.value;
    const [mirror1, mirror2] = outputLinksToLegacySlots(result.value, 2);
    patch.outputLink1 = mirror1;
    patch.outputLink2 = mirror2;
  } else if (legacyLinkProvided) {
    patch.outputLinks = outputLinksFromLegacy([
      patch.outputLink1 ?? null,
      patch.outputLink2 ?? null,
    ]);
  }

  if (body.output_images !== undefined) {
    const result = normalizeStringArray(body.output_images, "output_images");
    if (!result.ok) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.outputImages = result.value;
  }

  if (body.submission_opens_at !== undefined) {
    const result = normalizeIsoDatetimeField(body.submission_opens_at, "submission_opens_at", { required: true });
    if (!result.ok || !result.value) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.submissionOpensAt = result.value;
  }

  if (body.submission_closes_at !== undefined) {
    const result = normalizeIsoDatetimeField(body.submission_closes_at, "submission_closes_at", { required: true });
    if (!result.ok || !result.value) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.submissionClosesAt = result.value;
  }

  if (body.is_active !== undefined) {
    const result = normalizeBooleanField(body.is_active, "is_active", { required: true });
    if (!result.ok || result.value === undefined) return result as ParseBodyResult<Cluster4LinePatchInput>;
    patch.isActive = result.value;
  }

  if (
    patch.submissionOpensAt &&
    patch.submissionClosesAt &&
    new Date(patch.submissionOpensAt).getTime() > new Date(patch.submissionClosesAt).getTime()
  ) {
    return {
      ok: false,
      status: 400,
      error: "submission_opens_at must be earlier than or equal to submission_closes_at",
    };
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "Request body must include at least one writable field" };
  }

  return { ok: true, value: patch };
}

export function parseCluster4LineTargetCreateBody(
  body: unknown,
): ParseBodyResult<Cluster4LineTargetCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  if (typeof body.week_id !== "string" || body.week_id.trim().length === 0) {
    return { ok: false, status: 400, error: "week_id is required" };
  }
  if (!isTargetMode(body.target_mode)) {
    return { ok: false, status: 400, error: "target_mode must be one of user|rule" };
  }

  if (body.target_mode === "user") {
    if (typeof body.target_user_id !== "string" || body.target_user_id.trim().length === 0) {
      return { ok: false, status: 400, error: "target_user_id is required for target_mode='user'" };
    }
    return {
      ok: true,
      value: {
        weekId: body.week_id.trim(),
        targetMode: "user",
        targetUserId: body.target_user_id.trim(),
        targetRule: {},
      },
    };
  }

  const targetRule = normalizeRule(body.target_rule);
  if (!targetRule.ok) return targetRule as ParseBodyResult<Cluster4LineTargetCreateInput>;
  return {
    ok: true,
    value: {
      weekId: body.week_id.trim(),
      targetMode: "rule",
      targetUserId: null,
      targetRule: targetRule.value,
    },
  };
}

export function parseCluster4LineTargetPatchBody(
  body: unknown,
): ParseBodyResult<Cluster4LineTargetPatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const patch: Cluster4LineTargetPatchInput = {};

  if (body.week_id !== undefined) {
    if (typeof body.week_id !== "string" || body.week_id.trim().length === 0) {
      return { ok: false, status: 400, error: "week_id must be a non-empty string" };
    }
    patch.weekId = body.week_id.trim();
  }

  if (body.target_mode !== undefined) {
    if (!isTargetMode(body.target_mode)) {
      return { ok: false, status: 400, error: "target_mode must be one of user|rule" };
    }
    patch.targetMode = body.target_mode;
  }

  if (body.target_user_id !== undefined) {
    if (body.target_user_id !== null && (typeof body.target_user_id !== "string" || body.target_user_id.trim().length === 0)) {
      return { ok: false, status: 400, error: "target_user_id must be a string or null" };
    }
    patch.targetUserId =
      typeof body.target_user_id === "string" ? body.target_user_id.trim() : null;
  }

  if (body.target_rule !== undefined) {
    const targetRule = normalizeRule(body.target_rule);
    if (!targetRule.ok) return targetRule as ParseBodyResult<Cluster4LineTargetPatchInput>;
    patch.targetRule = targetRule.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "Request body must include at least one writable field" };
  }

  const nextMode = patch.targetMode ?? null;
  if (nextMode === "user" && !patch.targetUserId) {
    return { ok: false, status: 400, error: "target_user_id is required when target_mode='user'" };
  }
  if (nextMode === "rule" && patch.targetUserId !== undefined && patch.targetUserId !== null) {
    return { ok: false, status: 400, error: "target_user_id must be null when target_mode='rule'" };
  }

  return { ok: true, value: patch };
}
