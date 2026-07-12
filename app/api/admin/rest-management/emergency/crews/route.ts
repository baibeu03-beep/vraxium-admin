import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { assertAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScope";
import {
  EmergencyRestError,
  listEmergencyCrews,
} from "@/lib/adminEmergencyRest";

// GET /api/admin/rest-management/emergency/crews?organization=&teamId=&mode=
//
// 선택 팀에 현재 소속된 크루 목록(크루 코드·이름·클래스). teamId = cluster4_team_halves.id.
//   모집단 스코프(operating=실사용자/test=테스트 유저)는 mode 로 서비스가 적용(동일 코드 경로).
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const orgParam = params.get("organization")?.trim() || null;
  if (!isOrganizationSlug(orgParam)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${orgParam ?? ""}` },
      { status: 400 },
    );
  }
  const teamId = params.get("teamId")?.trim() || "";
  if (!teamId) {
    return Response.json({ success: false, error: "teamId is required" }, { status: 400 });
  }
  try {
    await assertAdminOrgAccess(admin, orgParam);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const mode = readScopeMode(params);

  try {
    const crews = await listEmergencyCrews(orgParam, teamId, mode);
    return Response.json({ success: true, teamId, crews });
  } catch (error) {
    if (error instanceof EmergencyRestError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/rest-management/emergency/crews GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load crews" },
      { status: 500 },
    );
  }
}
