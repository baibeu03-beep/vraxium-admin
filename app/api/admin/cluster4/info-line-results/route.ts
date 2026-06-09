import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";

// GET /api/admin/cluster4/info-line-results?week_id=
// 선택 주차의 "주차별 개설 결과" — 활동유형별 개설 상황(opened/needs_opening/not_open) + 카운트.
// 순수 read — snapshot/demoUserId/고객 DTO 무관.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const weekId = request.nextUrl.searchParams.get("week_id")?.trim() || null;
  if (!weekId || !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id is required and must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const data = await getInfoLineResultsForWeek({ weekId });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/info-line-results GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load info line results",
      },
      { status: 500 },
    );
  }
}
