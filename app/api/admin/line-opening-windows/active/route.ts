import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  LineOpeningWindowError,
  listActiveExceptionWeeks,
} from "@/lib/lineOpeningWindowsData";

// GET /api/admin/line-opening-windows/active
// 라인 개설 폼(섹션 0) 연동용 — 현재 활성 예외가 가리키는 주차 서술자 + 허용 라인.
// 개설 폼 주차 드롭다운에 "자동 정책 주차" 와 함께 "예외 허용 주차" 를 표시하기 위함.
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const weeks = await listActiveExceptionWeeks();
    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows/active GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list active windows",
      },
      { status: 500 },
    );
  }
}
