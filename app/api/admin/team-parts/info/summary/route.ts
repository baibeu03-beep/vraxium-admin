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
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { halfKeyForDate, normalizeHalfKeyParam } from "@/lib/teamHalf";

// 클럽 목록(상위 페이지) 요약.
//   GET ?[organization=]&[period=2026-H2]&[mode=test]
//     · organization 지정 → 해당 클럽 1행(guardAdminOrgAccess 로 권한 검증).
//     · 미지정(통합) → 전 조직 행.
//     · period 미지정/유효하지 않음 → 현재 반기로 안전 보정(400 을 내지 않는다).
//   모든 값 = 선택 반기(period) 기준. 일반/test 동일 함수·DTO(응답의 `period` 블록 참고).
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
  const today = getCurrentActivityDateIso();
  const rawPeriod =
    request.nextUrl.searchParams.get("period")?.trim() ||
    request.nextUrl.searchParams.get("half")?.trim() ||
    null;
  const halfKey = normalizeHalfKeyParam(rawPeriod, halfKeyForDate(today));

  try {
    const data = await loadClubCurrentSummary({ mode, orgs, halfKey });
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
