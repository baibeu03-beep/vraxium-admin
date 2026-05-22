import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CareerProjectError,
  deleteCareerProject,
  getCareerProject,
  updateCareerProject,
} from "@/lib/adminCareerProjectsData";
import {
  CAREER_PROJECTS_WRITE_ROLES,
  parseCareerProjectUpsertBody,
} from "@/lib/adminCareerProjectsTypes";

// /api/admin/career-projects/[id]
//   GET    — 단건 조회 (read roles)
//   PATCH  — 수정 (write roles: owner only)
//   DELETE — 삭제 (write roles: owner only). career_records 참조 시 409.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  try {
    const project = await getCareerProject(id);
    return Response.json({ success: true, data: { project } });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects/:id GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch career_project",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(CAREER_PROJECTS_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

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
    const project = await updateCareerProject(id, parsed.value);
    return Response.json({ success: true, data: { project } });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects/:id PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update career_project",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(CAREER_PROJECTS_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  try {
    await deleteCareerProject(id);
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects/:id DELETE]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to delete career_project",
      },
      { status: 500 },
    );
  }
}
