import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isUuid } from "@/lib/isUuid";
import {
  RestActionError,
  approveRestRequest,
  deleteRestRequest,
} from "@/lib/adminRestManagementData";
import { publicErrorMessage } from "@/lib/apiError";

// /api/admin/rest-management/[id]
//   PATCH  { action: "approve" } — pending → approved (종료 주차/이미 승인은 409 안내)
//   DELETE                       — 휴식 신청 삭제 (종료 주차는 409 "취소할 수 없습니다")

type Ctx = { params: Promise<{ id: string }> };

function restErrorResponse(error: unknown, label: string) {
  if (error instanceof RestActionError) {
    return Response.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error(label, error);
  return Response.json(
    { success: false, error: publicErrorMessage(error, 500, "요청 처리에 실패했습니다.") },
    { status: 500 },
  );
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "id must be a UUID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const action = (body as { action?: unknown })?.action;
  if (action !== "approve") {
    return Response.json({ success: false, error: "Unsupported action" }, { status: 400 });
  }

  try {
    // 이 라우트는 org 파라미터가 없다 → 대상 행의 org 로 허용 조직을 검증(403).
    const { allowedOrgs } = await resolveAdminOrgAccess(admin);
    await approveRestRequest(id, allowedOrgs);
    return Response.json({ success: true, data: { id, status: "approved" } });
  } catch (error) {
    return restErrorResponse(error, "[admin/rest-management/:id PATCH]");
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "id must be a UUID" }, { status: 400 });
  }

  try {
    // org 파라미터 없음 → 대상 행의 org 로 허용 조직 검증(403).
    const { allowedOrgs } = await resolveAdminOrgAccess(admin);
    await deleteRestRequest(id, allowedOrgs);
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    return restErrorResponse(error, "[admin/rest-management/:id DELETE]");
  }
}
