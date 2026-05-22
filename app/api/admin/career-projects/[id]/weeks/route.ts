import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CareerProjectError,
  attachCareerProjectWeek,
  detachCareerProjectWeek,
  listCareerProjectWeekStates,
  setCareerProjectWeekActive,
} from "@/lib/adminCareerProjectsData";
import {
  CAREER_PROJECTS_WRITE_ROLES,
  isCareerProjectWeekAction,
} from "@/lib/adminCareerProjectsTypes";

// /api/admin/career-projects/[id]/weeks
//   GET   — 해당 프로젝트의 주차 상태(전체 weeks × attached/is_active) 조회 (read roles)
//   PATCH — owner only. body 액션: attach | detach | set_active
//
// (project, week) pair 단위로만 동작. 다중 액션이 필요하면 클라이언트에서 순차 호출.

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
    const data = await listCareerProjectWeekStates(id);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects/:id/weeks GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list project weeks",
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

  if (!isCareerProjectWeekAction(body)) {
    return Response.json(
      {
        success: false,
        error:
          "Body must be { action: 'attach'|'detach'|'set_active', week_id: uuid, is_active?: boolean }",
      },
      { status: 400 },
    );
  }

  try {
    if (body.action === "attach") {
      const state = await attachCareerProjectWeek(
        id,
        body.week_id,
        body.is_active ?? true,
      );
      return Response.json({ success: true, data: { state } });
    }
    if (body.action === "detach") {
      await detachCareerProjectWeek(id, body.week_id);
      return Response.json({
        success: true,
        data: { week_id: body.week_id, attached: false },
      });
    }
    // set_active
    const state = await setCareerProjectWeekActive(
      id,
      body.week_id,
      body.is_active,
    );
    return Response.json({ success: true, data: { state } });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/career-projects/:id/weeks PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update project week",
      },
      { status: 500 },
    );
  }
}
