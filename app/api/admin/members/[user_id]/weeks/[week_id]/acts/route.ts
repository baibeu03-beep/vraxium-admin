import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { getCrewWeekActDetail } from "@/lib/adminCrewWeekActDetail";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// GET /api/admin/members/[user_id]/weeks/[week_id]/acts
//   회원별·주차별 상세 "액트 체크 내역" 탭 DTO. 고객 Detail Log 와 동일 SoT(process_point_awards 원장,
//   loadActLogsByStartDate) 재사용 — 취소된 액트도 취소됨 상태로 노출(includeCancelled). 조회 전용.
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id } = await params;

  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const result = await getCrewWeekActDetail(user_id, week_id);
    if (!result.ok) {
      const message =
        result.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    console.error("[admin/members/:user_id/weeks/:week_id/acts GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load acts" },
      { status: 500 },
    );
  }
}
