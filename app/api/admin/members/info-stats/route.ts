import type { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";
import { publicErrorMessage } from "@/lib/apiError";

// GET /api/admin/members/info-stats?organization=<all|encre|oranke|phalanx>&mode=<operating|test>
//   멤버 관리 > 크루 정보 [섹션.1] 집계(역대 누적 + 주차별 데이터). snapshot-only · 읽기 전용.
//   organization 미지정/all = 통합(3클럽 합산). 일반/demoUserId 경로 동일 DTO(org 전체 집계).
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const orgParam = params.get("organization")?.trim() || null;
  let organization: OrganizationSlug | "all" = "all";
  if (orgParam && orgParam !== "all") {
    if (!isOrganizationSlug(orgParam)) {
      return Response.json(
        { success: false, error: `Unknown organization: ${orgParam}` },
        { status: 400 },
      );
    }
    organization = orgParam;
  }
  const mode = parseScopeMode(params.get("mode"));

  try {
    const data = await loadMembersInfoStats({ organization, mode });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/members/info-stats GET]", error);
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, 500, "회원 통계를 불러오지 못했습니다."),
      },
      { status: 500 },
    );
  }
}
