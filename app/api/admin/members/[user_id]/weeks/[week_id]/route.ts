import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { getCrewWeekDetail } from "@/lib/adminCrewWeekDetail";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// GET /api/admin/members/[user_id]/weeks/[week_id]
//   회원별 · 주차별 상세(관리) 페이지 단건 DTO. 크루 페이지(/cluster-4-card)와 동일 SoT
//   (weekly-card snapshot + 강화 override overlay)를 재사용 — 일반/테스트/데모 경로 동일 DTO.
//
//   조회 전용. 개인 결과 수정은 별도 write API(예: enhancement-overrides)가 담당하며, 이 라우트는
//   클럽/주차 공통 데이터(라인 오픈 여부 등)를 노출하지도, 변경하지도 않는다.
//
//   보안: requireAdmin(read) + assertUserInRequestScope(mode 스코프 422) + loader 내부에서
//     weekId 가 그 회원의 스냅샷 카드에 실재하는지 검증(week_not_found → 404). URL 의 user_id/week_id
//     를 그대로 신뢰하지 않는다.
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
    const result = await getCrewWeekDetail(user_id, week_id);
    if (!result.ok) {
      const message =
        result.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    console.error("[admin/members/:user_id/weeks/:week_id GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load week detail",
      },
      { status: 500 },
    );
  }
}
