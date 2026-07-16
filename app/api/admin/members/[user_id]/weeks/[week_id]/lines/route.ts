import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// GET /api/admin/members/[user_id]/weeks/[week_id]/lines
//   회원별·주차별 상세 "라인 강화 내역" 탭 — 상단 요약 DTO. 크루 카드(/cluster-4-card)의 라인 DTO·
//   snapshot 계산 SoT 를 그대로 표현(재추정 없음). 포인트는 라인 개설 지급(source='line')만 집계. 조회 전용.
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
    const result = await getCrewWeekLineSummary(user_id, week_id);
    if (!result.ok) {
      const message =
        result.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    console.error("[admin/members/:user_id/weeks/:week_id/lines GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load line summary" },
      { status: 500 },
    );
  }
}
