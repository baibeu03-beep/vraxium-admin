// GET /api/admin/users/[user_id]/weekly-status
//
// 어드민 조회 전용 — 특정 사용자의 시즌/주차별 상태를 조합해 반환한다.
// 수정 기능 없음(GET only). 계산 로직은 lib/adminUserWeeklyStatusData 에서 단순 조합.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getUserWeeklyStatus } from "@/lib/adminUserWeeklyStatusData";

type Ctx = { params: Promise<{ user_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;
  const id = user_id?.trim();
  if (!id) {
    return Response.json(
      { success: false, error: "user_id is required." },
      { status: 400 },
    );
  }

  try {
    const data = await getUserWeeklyStatus(id);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/users/:user_id/weekly-status GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load user weekly status.",
      },
      { status: 500 },
    );
  }
}
