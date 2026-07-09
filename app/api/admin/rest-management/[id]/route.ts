import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import {
  RestActionError,
  approveRestRequest,
  deleteRestRequest,
} from "@/lib/adminRestManagementData";

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
    { success: false, error: error instanceof Error ? error.message : "요청 처리에 실패했습니다." },
    { status: 500 },
  );
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const action = (body as { action?: unknown })?.action;
  if (action !== "approve") {
    return Response.json({ success: false, error: "Unsupported action" }, { status: 400 });
  }

  try {
    await approveRestRequest(id);
    return Response.json({ success: true, data: { id, status: "approved" } });
  } catch (error) {
    return restErrorResponse(error, "[admin/rest-management/:id PATCH]");
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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
    await deleteRestRequest(id);
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    return restErrorResponse(error, "[admin/rest-management/:id DELETE]");
  }
}
