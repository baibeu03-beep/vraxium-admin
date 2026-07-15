// GET /api/admin/team-parts/info/weeks/[weekId]/review-readiness?club=&mode=
//
// "검수 준비 상태" 조회(읽기 전용). 검수 완료 전에 무엇이 부족한지 체크리스트로 반환한다.
//   ⚠ 아무것도 쓰지 않는다(finalize/point/uws 로직 무접촉). 안전장치와 동일 판정 재료를 read-only 로 조회.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { computeReviewReadiness } from "@/lib/adminWeekReviewReadiness";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";
import { isOrganizationSlug } from "@/lib/organizations";

type Ctx = { params: Promise<{ weekId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }
  // ?mode=test → scope=qa(테스트 코호트). 기본 operating.
  const scope = resolveStateScopeFromRequest(request);
  const club = request.nextUrl.searchParams.get("club")?.trim() ?? "";
  if (!isOrganizationSlug(club)) {
    return Response.json({ success: false, error: "club must be a valid organization slug" }, { status: 400 });
  }

  try {
    const readiness = await computeReviewReadiness(weekId, club, scope);
    return Response.json({ success: true, data: readiness });
  } catch (error) {
    console.error("[admin/team-parts/info/weeks/[weekId]/review-readiness GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "준비 상태 조회 실패" },
      { status: 500 },
    );
  }
}
