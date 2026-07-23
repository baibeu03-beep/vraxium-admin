import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { resolveTeamAnchorName } from "@/lib/adminTeamHalvesData";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import { isHalfKey } from "@/lib/teamHalf";

// 팀 상세 [A] — 선택 주차 요약.
//   GET ?organization=&teamHalfId=&weekId=[&mode=test]
//     · teamHalfId(앵커)로 팀(org+team_name) 확정 → 선택 주차 요약(크루 수·성장 결과·운용 파트).
//     · weekId 미지정/무효 → 현재 주차. 미래 주차는 선택 목록에 없음.
//     · 404: 미존재 id / 타 org / 비활성 / 스코프 불일치. 모든 mode·snapshot 경로 동일 함수·DTO.
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const organization = request.nextUrl.searchParams.get("organization")?.trim();
  if (!organization || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }
  const denied = await guardAdminOrgAccess(admin, organization);
  if (denied) return denied;

  const teamHalfId = request.nextUrl.searchParams.get("teamHalfId")?.trim();
  if (!teamHalfId) {
    return Response.json(
      { success: false, error: "teamHalfId 가 필요합니다." },
      { status: 400 },
    );
  }
  const weekId = request.nextUrl.searchParams.get("weekId")?.trim() || null;
  const halfParam = request.nextUrl.searchParams.get("half")?.trim() || null;
  const halfKey = halfParam && isHalfKey(halfParam) ? halfParam : null;
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const teamName = await resolveTeamAnchorName(organization, teamHalfId, mode);
    if (!teamName) {
      return Response.json(
        { success: false, error: "팀을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    const data = await getTeamSelectedWeekSummary({
      organization,
      teamName,
      weekId,
      halfKey,
      mode,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/team-detail/week-summary GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "주차 요약 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
