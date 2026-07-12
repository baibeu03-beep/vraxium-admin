import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { assertAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  RestActionError,
  bulkApproveRestRequests,
} from "@/lib/adminRestManagementData";

// POST /api/admin/rest-management/approve-all  { organization, season_key }
//   현재 org+season 의 pending(종료되지 않은 주차)만 일괄 승인. approved/이행은 불변.
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const org = (body as { organization?: unknown })?.organization;
  const seasonKey = (body as { season_key?: unknown })?.season_key;
  if (!isOrganizationSlug(org)) {
    return Response.json({ success: false, error: "organization required" }, { status: 400 });
  }
  if (typeof seasonKey !== "string" || !seasonKey.trim()) {
    return Response.json({ success: false, error: "season_key required" }, { status: 400 });
  }
  // 허용 조직 검증 — 허용되지 않은 org 일괄 승인 차단(403).
  try {
    await assertAdminOrgAccess(admin, org);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const result = await bulkApproveRestRequests(org, seasonKey.trim());
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof RestActionError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/rest-management/approve-all POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "일괄 승인에 실패했습니다." },
      { status: 500 },
    );
  }
}
