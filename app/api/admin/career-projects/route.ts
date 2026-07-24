import { NextRequest } from "next/server";
import { CAREER_DRIFT_NOTICE } from "@/lib/lineMasterDriftGuard";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CareerProjectError,
  createCareerProject,
  listCareerProjects,
} from "@/lib/adminCareerProjectsData";
import {
  CAREER_PROJECTS_WRITE_ROLES,
  parseCareerProjectUpsertBody,
} from "@/lib/adminCareerProjectsTypes";
import { publicErrorMessage } from "@/lib/apiError";
import { DEFAULT_TABLE_PAGE_SIZE } from "@/lib/tablePagination";

// /api/admin/career-projects
//   GET  — 목록 조회 (read roles: owner/admin/viewer)
//   POST — 생성 (write roles: owner only)
// 응답에 isSuperAdmin 을 함께 내려, 클라이언트가 액션 버튼 가시성을 결정한다.

function parseIntParam(
  raw: string | null,
  fallback: number,
  { min, max }: { min: number; max: number },
) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() || null;
  const limit = parseIntParam(params.get("limit"), DEFAULT_TABLE_PAGE_SIZE, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  try {
    const data = await listCareerProjects({ query: q, limit, offset });
    return Response.json({
      success: true,
      data: { ...data, isSuperAdmin: admin.role === "owner" },
    });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects GET]", error);
    return Response.json(
      {
        success: false,
        error:
          publicErrorMessage(error, 500, "실무 경력 정보를 처리하지 못했습니다."),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(CAREER_PROJECTS_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCareerProjectUpsertBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const project = await createCareerProject(parsed.value);
    return Response.json(
      { success: true, data: { project }, driftNotice: CAREER_DRIFT_NOTICE },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects POST]", error);
    return Response.json(
      {
        success: false,
        error:
          publicErrorMessage(error, 500, "실무 경력 정보를 처리하지 못했습니다."),
      },
      { status: 500 },
    );
  }
}
