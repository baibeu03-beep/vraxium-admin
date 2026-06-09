import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  LineOpeningWindowError,
  createLineOpeningWindows,
  listLineOpeningWindows,
} from "@/lib/lineOpeningWindowsData";

// GET /api/admin/line-opening-windows
// 등록된 라인 개설 예외 목록(활성/비활성 모두) — 화면 3.
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const windows = await listLineOpeningWindows();
    return Response.json({ success: true, data: { windows } });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list windows",
      },
      { status: 500 },
    );
  }
}

// POST /api/admin/line-opening-windows
// 예외 등록 — 화면 2. body:
//   { week_id, scope: "all" | "lines", activity_type_ids?: string[] }
//   scope=all  → 해당 주차 전체(activity_type_id NULL) 1행.
//   scope=lines → activity_type_ids 각각 1행.
export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const weekId = typeof input.week_id === "string" ? input.week_id.trim() : "";
  if (!weekId) {
    return Response.json(
      { success: false, error: "week_id is required" },
      { status: 400 },
    );
  }

  const scope = input.scope === "lines" ? "lines" : "all";
  let activityTypeIds: string[] | null = null;
  if (scope === "lines") {
    if (!Array.isArray(input.activity_type_ids)) {
      return Response.json(
        { success: false, error: "activity_type_ids must be an array" },
        { status: 400 },
      );
    }
    const ids = input.activity_type_ids.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (ids.length === 0) {
      return Response.json(
        { success: false, error: "특정 라인 허용 시 최소 1개 선택해주세요" },
        { status: 400 },
      );
    }
    activityTypeIds = ids;
  }

  try {
    const windows = await createLineOpeningWindows({
      weekId,
      activityTypeIds,
      createdBy: admin.userId ?? null,
    });
    return Response.json({ success: true, data: { windows } }, { status: 201 });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create window",
      },
      { status: 500 },
    );
  }
}
