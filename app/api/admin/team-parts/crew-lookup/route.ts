import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { lookupCrewByCode } from "@/lib/adminTeamHalvesData";
import { readScopeMode } from "@/lib/userScopeShared";

// 팀장 크루코드 [호출] — crew_code 로 등록된 크루를 조회(11개 필드).
//   조회 안 되면 404(팀장 등록 불가). 인물 정보 SoT=기존 크루/프로필.
//   ⚠ organization 필수 — 팀장은 팀과 동일 조직 강제. 타 조직/타 모드 크루는 404(fail-closed).
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return Response.json(
      { success: false, error: "크루코드가 필요합니다." },
      { status: 400 },
    );
  }

  // 조직 필수 — 팀 등록 org 컨텍스트와 동일해야 한다. 없으면 전역 검색을 막고 400.
  const organization = request.nextUrl.searchParams.get("organization")?.trim();
  if (!organization || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }
  const denied = await guardAdminOrgAccess(admin, organization);
  if (denied) return denied;

  try {
    // ?mode=test → QA(테스트 크루만). 미지정=operating(실사용자만). org·mode 스코프 밖 크루는 404.
    const crew = await lookupCrewByCode(
      code,
      readScopeMode(request.nextUrl.searchParams),
      organization,
    );
    if (!crew) {
      return Response.json(
        {
          success: false,
          error:
            "현재 조직 및 모드에 해당하는 크루만 호출할 수 있습니다. 팀장은 이미 등록된 크루만 가능합니다.",
        },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: crew });
  } catch (error) {
    console.error("[admin/team-parts/crew-lookup GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "크루 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
