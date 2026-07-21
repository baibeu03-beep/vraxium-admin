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
import { loadTeamDetail } from "@/lib/adminTeamHalvesData";

// 팀 상세(클럽 상세 → 팀 상세).
//   GET ?organization=&teamHalfId=&half=
//     · teamHalfId(앵커) 로 팀(org+team_name)을 확정하고 선택 반기의 상세를 반환.
//     · 404: 미존재 id / 타 org / 비활성(삭제 대기) / 스코프(QA) 불일치. (loadTeamDetail null)
//   모든 값 구조는 loadTeamPartsInfo 와 동일 원천 — 크루 수만 현재 시점(팀명 기준·반기 무관).
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

  const half = request.nextUrl.searchParams.get("half")?.trim() || null;
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await loadTeamDetail({
      organization,
      anchorTeamHalfId: teamHalfId,
      selectedHalfKey: half,
      mode,
    });
    if (!data) {
      return Response.json(
        { success: false, error: "팀을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/team-detail GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "팀 상세 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
