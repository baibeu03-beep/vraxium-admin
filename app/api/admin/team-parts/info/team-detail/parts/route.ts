import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { createTeamPart, TeamHalfWriteError } from "@/lib/adminTeamHalvesData";

// 팀 상세 — 파트 생성.
//   POST ?mode=test  body { organization, teamHalfId, name }
//     · 현재 반기 팀(team_name)에 사용자 생성 파트 추가. "일반"은 시스템 기본이라 생성 불가.
//     · 검증(서버 SoT): org 접근·팀 존재/활성/스코프·현재 반기 편집 가능·이름(trim/빈값/길이/중복)·한도(6).
//     · 새 파트 = 크루 0명(운용 아님) — 카탈로그 레코드만 추가.
export async function POST(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  const { organization, teamHalfId, name } = (body ?? {}) as {
    organization?: unknown;
    teamHalfId?: unknown;
    name?: unknown;
  };

  if (typeof organization !== "string" || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }
  const denied = await guardAdminOrgAccess(admin, organization);
  if (denied) return denied;
  if (typeof teamHalfId !== "string" || !teamHalfId.trim()) {
    return Response.json(
      { success: false, error: "teamHalfId 가 필요합니다." },
      { status: 400 },
    );
  }
  if (typeof name !== "string") {
    return Response.json(
      { success: false, error: "name 이 필요합니다." },
      { status: 400 },
    );
  }

  const mode = readScopeMode(request.nextUrl.searchParams);
  try {
    const part = await createTeamPart({
      organization,
      anchorTeamHalfId: teamHalfId,
      name,
      mode,
    });
    return Response.json({ success: true, data: { part } });
  } catch (error) {
    if (error instanceof TeamHalfWriteError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/team-parts/info/team-detail/parts POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "파트 생성에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
