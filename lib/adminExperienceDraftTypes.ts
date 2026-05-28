// Browser-safe types and parsers for experience line draft workflow APIs.

import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { isUuid } from "@/lib/isUuid";

export { CLUSTER4_LINE_WRITE_ROLES as EXPERIENCE_DRAFT_WRITE_ROLES };

// ── Status literals ────────────────────────────────────────

export type InputStatus = "draft" | "submitted";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type OpenStatus = "pending" | "opened";

// ── DTOs ───────────────────────────────────────────────────

export type ExperienceDraftDto = {
  id: string;
  weekId: string;
  organizationSlug: string;
  teamId: string | null;
  teamName: string | null;
  partName: string | null;
  targetUserId: string;
  targetUserName: string | null;
  experienceLineMasterId: string;
  lineCode: string;
  lineName: string | null;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputImages: string[];
  rating: number | null;
  memo: string | null;
  inputStatus: InputStatus;
  reviewStatus: ReviewStatus;
  openStatus: OpenStatus;
  rejectionReason: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  openedBy: string | null;
  openedAt: string | null;
  openedLineId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExperienceDraftRow = {
  id: string;
  week_id: string;
  organization_slug: string;
  team_id: string | null;
  part_name: string | null;
  target_user_id: string;
  experience_line_master_id: string;
  line_code: string;
  main_title: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_images: string[];
  rating: number | null;
  memo: string | null;
  input_status: InputStatus;
  review_status: ReviewStatus;
  open_status: OpenStatus;
  rejection_reason: string | null;
  entered_by: string | null;
  entered_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  opened_by: string | null;
  opened_at: string | null;
  opened_line_id: string | null;
  created_at: string;
  updated_at: string;
  // joined relations (optional)
  cluster4_teams?: { team_name: string } | null;
  user_profiles?: { display_name: string | null } | null;
  cluster4_experience_line_masters?: { line_name: string } | null;
};

// ── Input types ────────────────────────────────────────────

export type ExperienceDraftCreateInput = {
  weekId: string;
  organizationSlug: string;
  teamId: string | null;
  partName: string | null;
  targetUserId: string;
  experienceLineMasterId: string;
  lineCode: string;
  mainTitle: string;
  outputLink1: string | null;
  outputLink2: string | null;
  outputImages: string[];
  rating: number | null;
  memo: string | null;
  inputStatus: InputStatus;
};

export type ExperienceDraftPatchInput = {
  teamId?: string | null;
  partName?: string | null;
  experienceLineMasterId?: string;
  lineCode?: string;
  mainTitle?: string;
  outputLink1?: string | null;
  outputLink2?: string | null;
  outputImages?: string[];
  rating?: number | null;
  memo?: string | null;
  inputStatus?: InputStatus;
};

export type ExperienceDraftReviewInput = {
  reviewStatus: "approved" | "rejected";
  rejectionReason: string | null;
};

export type ExperienceDraftOpenInput = {
  draftIds: string[];
};

// ── Parse helpers ──────────────────────────────────────────

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseOutputImages(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const result: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed.length > 0) result.push(trimmed);
  }
  return result;
}

function countOutputAssets(
  link1: string | null,
  link2: string | null,
  images: string[],
): number {
  return (link1 ? 1 : 0) + (link2 ? 1 : 0) + images.length;
}

// ── Create parser ──────────────────────────────────────────

export function parseExperienceDraftCreateBody(
  body: unknown,
): ParseResult<ExperienceDraftCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const weekId = trimOrNull(body.week_id);
  if (!weekId || !isUuid(weekId)) {
    return { ok: false, status: 400, error: "week_id is required (UUID)" };
  }

  const targetUserId = trimOrNull(body.target_user_id);
  if (!targetUserId || !isUuid(targetUserId)) {
    return { ok: false, status: 400, error: "target_user_id is required (UUID)" };
  }

  const experienceLineMasterId = trimOrNull(body.experience_line_master_id);
  if (!experienceLineMasterId || !isUuid(experienceLineMasterId)) {
    return { ok: false, status: 400, error: "experience_line_master_id is required (UUID)" };
  }

  const organizationSlug = trimOrNull(body.organization_slug) ?? "oranke";

  const teamId = body.team_id !== undefined ? trimOrNull(body.team_id) : null;
  if (teamId !== null && !isUuid(teamId)) {
    return { ok: false, status: 400, error: "team_id must be a UUID or null" };
  }

  const partName = trimOrNull(body.part_name);

  const lineCode = trimOrNull(body.line_code);
  const mainTitle = trimOrNull(body.main_title);

  const outputLink1 = trimOrNull(body.output_link_1);
  const outputLink2 = trimOrNull(body.output_link_2);

  const outputImages = parseOutputImages(body.output_images);
  if (outputImages === null) {
    return { ok: false, status: 400, error: "output_images must be an array of strings" };
  }

  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null) {
    if (typeof body.rating !== "number" || !Number.isInteger(body.rating)) {
      return { ok: false, status: 400, error: "rating must be an integer" };
    }
    if (body.rating < 0 || body.rating > 10) {
      return { ok: false, status: 400, error: "rating must be between 0 and 10" };
    }
    rating = body.rating;
  }

  const memo = trimOrNull(body.memo);

  let inputStatus: InputStatus = "draft";
  if (body.input_status !== undefined) {
    if (body.input_status !== "draft" && body.input_status !== "submitted") {
      return { ok: false, status: 400, error: "input_status must be 'draft' or 'submitted'" };
    }
    inputStatus = body.input_status;
  }

  if (inputStatus === "submitted") {
    if (!lineCode) {
      return { ok: false, status: 400, error: "제출 시 line_code는 필수입니다" };
    }
    if (!mainTitle) {
      return { ok: false, status: 400, error: "제출 시 main_title은 필수입니다" };
    }
    if (rating === null) {
      return { ok: false, status: 400, error: "제출 시 평점은 필수입니다" };
    }
    const assetCount = countOutputAssets(outputLink1, outputLink2, outputImages);
    if (assetCount < 1) {
      return { ok: false, status: 400, error: "제출 시 Output을 최소 1개 입력해주세요 (Link + Image 합산)" };
    }
    if (assetCount > 2) {
      return { ok: false, status: 400, error: "Output은 최대 2개까지 입력 가능합니다 (Link + Image 합산)" };
    }
  }

  if (inputStatus === "draft") {
    if (!lineCode && !mainTitle) {
      return { ok: false, status: 400, error: "line_code 또는 main_title 중 하나는 필수입니다" };
    }
  }

  return {
    ok: true,
    value: {
      weekId,
      organizationSlug,
      teamId,
      partName,
      targetUserId,
      experienceLineMasterId,
      lineCode: lineCode ?? "",
      mainTitle: mainTitle ?? "",
      outputLink1,
      outputLink2,
      outputImages,
      rating,
      memo,
      inputStatus,
    },
  };
}

// ── Patch parser ───────────────────────────────────────────

export function parseExperienceDraftPatchBody(
  body: unknown,
): ParseResult<ExperienceDraftPatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const patch: ExperienceDraftPatchInput = {};
  let hasField = false;

  if (body.team_id !== undefined) {
    const v = body.team_id === null ? null : trimOrNull(body.team_id);
    if (v !== null && !isUuid(v)) {
      return { ok: false, status: 400, error: "team_id must be a UUID or null" };
    }
    patch.teamId = v;
    hasField = true;
  }

  if (body.part_name !== undefined) {
    patch.partName = trimOrNull(body.part_name);
    hasField = true;
  }

  if (body.experience_line_master_id !== undefined) {
    const v = trimOrNull(body.experience_line_master_id);
    if (!v || !isUuid(v)) {
      return { ok: false, status: 400, error: "experience_line_master_id must be a UUID" };
    }
    patch.experienceLineMasterId = v;
    hasField = true;
  }

  if (body.line_code !== undefined) {
    const v = trimOrNull(body.line_code);
    if (!v) {
      return { ok: false, status: 400, error: "line_code must not be empty" };
    }
    patch.lineCode = v;
    hasField = true;
  }

  if (body.main_title !== undefined) {
    const v = trimOrNull(body.main_title);
    if (!v) {
      return { ok: false, status: 400, error: "main_title must not be empty" };
    }
    patch.mainTitle = v;
    hasField = true;
  }

  if (body.output_link_1 !== undefined) {
    patch.outputLink1 = trimOrNull(body.output_link_1);
    hasField = true;
  }

  if (body.output_link_2 !== undefined) {
    patch.outputLink2 = trimOrNull(body.output_link_2);
    hasField = true;
  }

  if (body.output_images !== undefined) {
    const imgs = parseOutputImages(body.output_images);
    if (imgs === null) {
      return { ok: false, status: 400, error: "output_images must be an array of strings" };
    }
    patch.outputImages = imgs;
    hasField = true;
  }

  if (body.rating !== undefined) {
    if (body.rating === null) {
      patch.rating = null;
    } else {
      if (typeof body.rating !== "number" || !Number.isInteger(body.rating)) {
        return { ok: false, status: 400, error: "rating must be an integer" };
      }
      if (body.rating < 0 || body.rating > 10) {
        return { ok: false, status: 400, error: "rating must be between 0 and 10" };
      }
      patch.rating = body.rating;
    }
    hasField = true;
  }

  if (body.memo !== undefined) {
    patch.memo = trimOrNull(body.memo);
    hasField = true;
  }

  if (body.input_status !== undefined) {
    if (body.input_status !== "draft" && body.input_status !== "submitted") {
      return { ok: false, status: 400, error: "input_status must be 'draft' or 'submitted'" };
    }
    patch.inputStatus = body.input_status;
    hasField = true;
  }

  if (!hasField) {
    return { ok: false, status: 400, error: "Request body must include at least one field" };
  }

  return { ok: true, value: patch };
}

// ── Review parser ──────────────────────────────────────────

export function parseExperienceDraftReviewBody(
  body: unknown,
): ParseResult<ExperienceDraftReviewInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  if (body.review_status !== "approved" && body.review_status !== "rejected") {
    return { ok: false, status: 400, error: "review_status must be 'approved' or 'rejected'" };
  }

  let rejectionReason: string | null = null;
  if (body.review_status === "rejected") {
    rejectionReason = trimOrNull(body.rejection_reason);
    if (!rejectionReason) {
      return { ok: false, status: 400, error: "반려 시 rejection_reason은 필수입니다" };
    }
  }

  return {
    ok: true,
    value: {
      reviewStatus: body.review_status,
      rejectionReason,
    },
  };
}

// ── Open parser ────────────────────────────────────────────

export function parseExperienceDraftOpenBody(
  body: unknown,
): ParseResult<ExperienceDraftOpenInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  if (!Array.isArray(body.draft_ids) || body.draft_ids.length === 0) {
    return { ok: false, status: 400, error: "draft_ids는 1개 이상의 UUID 배열이어야 합니다" };
  }

  const draftIds: string[] = [];
  for (const id of body.draft_ids) {
    if (typeof id !== "string" || !isUuid(id)) {
      return { ok: false, status: 400, error: "draft_ids의 모든 항목은 유효한 UUID여야 합니다" };
    }
    draftIds.push(id);
  }

  return { ok: true, value: { draftIds } };
}
