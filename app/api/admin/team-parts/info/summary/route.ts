import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { loadClubCurrentSummary } from "@/lib/adminClubSummaryData";

// 클럽 목록(상위 페이지) 요약.
//   GET ?[organization=]&[mode=test]
//     · organization 지정 → 해당 클럽 1행(guardAdminOrgAccess 로 권한 검증).
//     · 미지정(통합) → 전 조직 행.
//   모든 값 = 현재 접속 시점 기준(상세 페이지의 selectedHalf 와 무관). 일반/test 동일 함수·DTO.
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const organization = request.nextUrl.searchParams.get("organization")?.trim() || null;
  let orgs: OrganizationSlug[] | undefined;
  if (organization) {
    if (!isOrganizationSlug(organization)) {
      return Response.json(
        { success: false, error: "유효한 organization 이 필요합니다." },
        { status: 400 },
      );
    }
    const denied = await guardAdminOrgAccess(admin, organization);
    if (denied) return denied;
    orgs = [organization];
  }

  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await loadClubCurrentSummary({ mode, orgs });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/summary GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "클럽 요약 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
