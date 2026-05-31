import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { EditWindowError, listWeekOptions } from "@/lib/adminEditWindowsData";

// GET /api/admin/edit-windows/weeks
// 주간 자원 권한을 열 때 admin 이 고를 수 있는 주차 목록(weeks ⨝ season_definitions).
// label 예: "2026 봄 시즌 12주차".
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const weeks = await listWeekOptions();
    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/edit-windows/weeks GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list weeks",
      },
      { status: 500 },
    );
  }
}
