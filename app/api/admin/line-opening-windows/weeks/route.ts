import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  LineOpeningWindowError,
  listExceptionWeekFormOptions,
} from "@/lib/lineOpeningWindowsData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

// GET /api/admin/line-opening-windows/weeks
// 예외 등록 폼(화면 2) 주차 드롭다운 옵션 — weeks 에 존재하는 전 시즌·전 주차(동적).
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const todayIso = getCurrentActivityDateIso();
    const weeks = await listExceptionWeekFormOptions(todayIso);
    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows/weeks GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list weeks",
      },
      { status: 500 },
    );
  }
}
