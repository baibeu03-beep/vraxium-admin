// 클럽 정보 > 주차 내역 > 활동 관리 > [라인 개설 관리] 탭 조회.
//   GET ?club=encre|oranke|phalanx[&mode=test]
//     → "주차 전체 라인칸 개설 관리" 요약 집계(totalLines/openLines/createdLines/notCreatedLines/lineOpenRate).
//   snapshot-only 조회. "오픈" 판정은 오픈 확인된 라인 설정 기준. 실무 경력은 집계 제외.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { loadTeamPartsInfoLineOpeningManagement } from "@/lib/adminTeamPartsInfoLineOpeningData";

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

  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await loadTeamPartsInfoLineOpeningManagement({ weekId, organization: club, mode });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/weeks/[weekId]/line-opening-management GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "조회에 실패했습니다." },
      { status: 500 },
    );
  }
}
