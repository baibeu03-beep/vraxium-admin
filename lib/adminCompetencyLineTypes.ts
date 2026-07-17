// Browser-safe types for competency line master admin APIs.

import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import type { LineDurationMinutes } from "@/lib/adminLineRegistrationsTypes";

export { CLUSTER4_LINE_WRITE_ROLES as COMPETENCY_LINE_WRITE_ROLES };

export type CompetencyLineMasterDto = {
  id: string;
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  sourceFileName: string | null;
  isActive: boolean;
  // 예상 소요 시간(분) — SoT = line_registrations.estimated_duration_minutes (마스터 속성).
  //   여기서는 조회만 한다(이 화면은 소요 시간을 쓰지 않는다 — 편집은 /admin/lines 등록·수정).
  //   레거시 마스터 fallback 경로 · 마이그 전에는 null. DTO 필드명은 라인 등록과 동일하게 유지.
  estimatedDurationMinutes: LineDurationMinutes | null;
  createdAt: string;
  updatedAt: string;
};

export type CompetencyLineMasterCreateInput = {
  organizationSlug: string;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  sourceFileName: string | null;
  isActive: boolean;
};

export type CompetencyLineMasterPatchInput = Partial<Omit<CompetencyLineMasterCreateInput, "organizationSlug">> & {
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

export function parseCompetencyLineMasterCreateBody(
  body: unknown,
): ParseResult<CompetencyLineMasterCreateInput> {
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
    value: { organizationSlug, lineCode, lineName, mainTitle, sourceFileName, isActive },
  };
}

export function parseCompetencyLineMasterPatchBody(
  body: unknown,
): ParseResult<CompetencyLineMasterPatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const patch: CompetencyLineMasterPatchInput = {};

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
