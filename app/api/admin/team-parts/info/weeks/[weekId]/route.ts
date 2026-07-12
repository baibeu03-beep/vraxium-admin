// 클럽 정보 > 주차 내역 > 활동 관리(상세) 조회.
//   GET ?club=encre|oranke|phalanx[&mode=test]
//     → currentWeek · managedWeek · openingConfig (허브/라인 오픈 설정 체크 상태).
//   snapshot-only 조회. mode 는 실무 경험 팀 스코프에만 영향(DTO 구조 동일).

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import {
  loadTeamPartsInfoWeekDetail,
  WeekDetailNotFoundError,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

type Ctx = { params: Promise<{ weekId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  const club = request.nextUrl.searchParams.get("club")?.trim() ?? "";
  if (club === "all" || club === "integrated") {
    return Response.json({ success: false, error: "통합 탭은 준비 중입니다." }, { status: 400 });
  }
  if (!isOrganizationSlug(club)) {
    return Response.json(
      { success: false, error: "유효한 club(encre·oranke·phalanx)이 필요합니다." },
      { status: 400 },
    );
  }
  const denied = await guardAdminOrgAccess(admin, club);
  if (denied) return denied;

  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await loadTeamPartsInfoWeekDetail({ weekId, organization: club, mode });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeekDetailNotFoundError) {
      return Response.json({ success: false, error: error.message }, { status: 404 });
    }
    console.error("[admin/team-parts/info/weeks/[weekId] GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "조회에 실패했습니다." },
      { status: 500 },
    );
  }
}
