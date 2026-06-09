// Browser-safe types for experience line master admin APIs.

import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import type { Cluster4ExperienceCategory } from "@/lib/cluster4LinesTypes";

export { CLUSTER4_LINE_WRITE_ROLES as EXPERIENCE_LINE_WRITE_ROLES };
export type { Cluster4ExperienceCategory } from "@/lib/cluster4LinesTypes";

export type ExperienceLineMasterDto = {
  id: string;
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  sourceFileName: string | null;
  isActive: boolean;
  // 5슬롯 분류 (cluster4_experience_line_masters.experience_category / experience_slot_order).
  // 미분류면 null. 어드민 표시 전용(읽기).
  experienceCategory: Cluster4ExperienceCategory | null;
  experienceSlotOrder: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ExperienceLineMasterCreateInput = {
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  teamId: string | null;
  sourceFileName: string | null;
  isActive: boolean;
};

export type ExperienceLineMasterPatchInput = Partial<Omit<ExperienceLineMasterCreateInput, "organizationSlug">> & {
  organizationSlug?: string;
};

export type ParseResult<T> =
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

export function parseExperienceLineMasterCreateBody(
  body: unknown,
): ParseResult<ExperienceLineMasterCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const organizationSlug = trimOrNull(body.organization_slug);
  if (!organizationSlug) {
    return { ok: false, status: 400, error: "organization_slug is required" };
  }

  const lineCode = trimOrNull(body.line_code);
  if (!lineCode) {
    return { ok: false, status: 400, error: "line_code is required" };
  }

  const lineName = trimOrNull(body.line_name);
  if (!lineName) {
    return { ok: false, status: 400, error: "line_name is required" };
  }

  const mainTitle = trimOrNull(body.main_title);
  const teamId = trimOrNull(body.team_id);
  const sourceFileName = trimOrNull(body.source_file_name);

  let isActive = true;
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return { ok: false, status: 400, error: "is_active must be a boolean" };
    }
    isActive = body.is_active;
  }

  return {
    ok: true,
    value: { organizationSlug, lineCode, lineName, mainTitle, teamId, sourceFileName, isActive },
  };
}

export function parseExperienceLineMasterPatchBody(
  body: unknown,
): ParseResult<ExperienceLineMasterPatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const patch: ExperienceLineMasterPatchInput = {};

  if (body.organization_slug !== undefined) {
    const v = trimOrNull(body.organization_slug);
    if (!v) return { ok: false, status: 400, error: "organization_slug must not be empty" };
    patch.organizationSlug = v;
  }

  if (body.line_code !== undefined) {
    const v = trimOrNull(body.line_code);
    if (!v) return { ok: false, status: 400, error: "line_code must not be empty" };
    patch.lineCode = v;
  }

  if (body.line_name !== undefined) {
    const v = trimOrNull(body.line_name);
    if (!v) return { ok: false, status: 400, error: "line_name must not be empty" };
    patch.lineName = v;
  }

  if (body.main_title !== undefined) {
    patch.mainTitle = trimOrNull(body.main_title);
  }

  if (body.team_id !== undefined) {
    patch.teamId = trimOrNull(body.team_id);
  }

  if (body.source_file_name !== undefined) {
    patch.sourceFileName = trimOrNull(body.source_file_name);
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return { ok: false, status: 400, error: "is_active must be a boolean" };
    }
    patch.isActive = body.is_active;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "Request body must include at least one field" };
  }

  return { ok: true, value: patch };
}

export type CrewItemDto = {
  userId: string;
  displayName: string;
  // 운영용 크루 번호(crew_no). 마이그레이션 미적용/미발급이면 null.
  crewNo: number | null;
  profileImg: string | null;
  organization: string | null;
  teamName: string | null;
  partName: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
};
