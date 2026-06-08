// GET /api/admin/lines/catalog — 통합 라인 카탈로그 (Phase 2B, read-only merge).
//
// 4개 원천(경험/역량 마스터 · career_projects · line_registrations)을 조회 시점에만 합친다.
// 쓰기 핸들러 없음(GET only). 기존 SoT·기존 API 응답·snapshot·개설 플로우 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isLineRegistrationHub } from "@/lib/adminLineRegistrationsTypes";
import {
  LINE_CATALOG_SOURCES,
  type LineCatalogSort,
  type LineCatalogSource,
} from "@/lib/adminLineCatalogTypes";
import { LineCatalogError, listLineCatalog } from "@/lib/adminLineCatalogData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;

  const hubRaw = params.get("hub")?.trim() || null;
  if (hubRaw !== null && !isLineRegistrationHub(hubRaw)) {
    return Response.json(
      { success: false, error: "hub must be one of info|experience|competency|career" },
      { status: 400 },
    );
  }
  const hub = hubRaw !== null && isLineRegistrationHub(hubRaw) ? hubRaw : null;

  const sourceRaw = params.get("source")?.trim() || null;
  if (
    sourceRaw !== null &&
    !(LINE_CATALOG_SOURCES as readonly string[]).includes(sourceRaw)
  ) {
    return Response.json(
      {
        success: false,
        error: `source must be one of ${LINE_CATALOG_SOURCES.join("|")}`,
      },
      { status: 400 },
    );
  }
  const source = sourceRaw as LineCatalogSource | null;

  const sortRaw = params.get("sort")?.trim() || "latest";
  if (sortRaw !== "latest" && sortRaw !== "oldest") {
    return Response.json(
      { success: false, error: "sort must be 'latest' or 'oldest'" },
      { status: 400 },
    );
  }
  const sort = sortRaw as LineCatalogSort;

  const query = params.get("q")?.trim() || null;

  try {
    const result = await listLineCatalog({ hub, source, query, sort });
    return Response.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof LineCatalogError ? error.status : 500;
    console.error("[lines/catalog GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
