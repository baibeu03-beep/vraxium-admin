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
  loadEmergencyContext,
} from "@/lib/adminEmergencyRest";

// GET /api/admin/rest-management/emergency/context?organization=&mode=&actAsTestUserId=
//
// 긴급 휴식 신청 모달 초기 데이터 — 신청자(actor)·소속 팀·신청 가능 주차·Po.C(2).
//   actor 는 서버가 결정한다(mode/actAsTestUserId 반영·URL org 로 권한 판단 금지).
//   mode/actAsTestUserId 는 URL 로 받아 동일 서비스에 위임(모드별 분기 없음).
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
  try {
    await assertAdminOrgAccess(admin, orgParam);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const mode = readScopeMode(params);
  const actAsTestUserId = params.get("actAsTestUserId")?.trim() || null;

  try {
    const context = await loadEmergencyContext(orgParam, mode, admin, actAsTestUserId);
    return Response.json({ success: true, context });
  } catch (error) {
    if (error instanceof EmergencyRestError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/rest-management/emergency/context GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load context" },
      { status: 500 },
    );
  }
}
