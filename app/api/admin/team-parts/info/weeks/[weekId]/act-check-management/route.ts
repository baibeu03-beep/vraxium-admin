// 클럽 정보 > 주차 내역 > 활동 관리 > [액트 체크 관리] 탭 조회.
//   GET ?club=encre|oranke|phalanx[&mode=test]
//     → 주차 전체/실무 정보 허브 액트 체크 집계 + 실무 정보 라인별 정규 액트 목록.
//   snapshot-only 조회. "가동" 판정은 오픈 확인된 라인/허브 설정 기준.

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
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";

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
    const data = await loadTeamPartsInfoActCheckManagement({ weekId, organization: club, mode });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/weeks/[weekId]/act-check-management GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "조회에 실패했습니다." },
      { status: 500 },
    );
  }
}
