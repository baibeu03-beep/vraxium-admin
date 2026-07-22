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
  createEmergencyRest,
} from "@/lib/adminEmergencyRest";
import { publicErrorMessage } from "@/lib/apiError";

// POST /api/admin/rest-management/emergency?mode=&actAsTestUserId=
//   body: { organization, teamId, crewUserId, weekId, reason }
//
// 긴급 휴식 생성 — 신청자(actor)는 서버가 결정한다(클라 제출 값 신뢰 금지). 성공 시 휴식 행(urgent·
//   status=approved) 생성 + 대상 크루 Po.C ×2 지급(변동 액트 파이프라인). 원자적 흐름 + 실패 보상.
export async function POST(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: {
    organization?: unknown;
    teamId?: unknown;
    crewUserId?: unknown;
    weekId?: unknown;
    reason?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const orgParam = typeof body.organization === "string" ? body.organization.trim() : "";
  if (!isOrganizationSlug(orgParam)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${orgParam}` },
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

  const teamId = typeof body.teamId === "string" ? body.teamId.trim() : "";
  const crewUserId = typeof body.crewUserId === "string" ? body.crewUserId.trim() : "";
  const weekId = typeof body.weekId === "string" ? body.weekId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!teamId || !crewUserId || !weekId) {
    return Response.json(
      { success: false, error: "팀, 크루, 주차를 모두 선택해주세요." },
      { status: 400 },
    );
  }

  const params = request.nextUrl.searchParams;
  const mode = readScopeMode(params);
  const actAsTestUserId = params.get("actAsTestUserId")?.trim() || null;

  try {
    const result = await createEmergencyRest({
      admin,
      mode,
      actAsTestUserId,
      organization: orgParam,
      teamId,
      crewUserId,
      weekId,
      reason,
    });
    return Response.json({
      success: true,
      request: { id: result.id, status: result.resultingStatus },
      awardedPoint: { key: "po.C", amount: 2 },
    });
  } catch (error) {
    if (error instanceof EmergencyRestError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/rest-management/emergency POST]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, 500, "긴급 휴식 처리를 완료하지 못했습니다.") },
      { status: 500 },
    );
  }
}
