import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import {
  deleteManualCompetencyApplication,
  updateCompetencyApplication,
} from "@/lib/adminCompetencyApplications";

// 실무 역량 신청 1건 갱신/삭제.
//   PATCH  { cafe_checked?, approval_checked?, rejection_reason? }
//   DELETE  — source='manual'(수동 추가) 항목만 삭제 허용. 고객 신청(customer)은 403.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "유효하지 않은 id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const patch: {
    cafeChecked?: boolean;
    approvalChecked?: boolean;
    rejectionReason?: string | null;
  } = {};
  if (typeof b.cafe_checked === "boolean") patch.cafeChecked = b.cafe_checked;
  if (typeof b.approval_checked === "boolean") patch.approvalChecked = b.approval_checked;
  if (b.rejection_reason === null) patch.rejectionReason = null;
  else if (typeof b.rejection_reason === "string")
    patch.rejectionReason = b.rejection_reason.trim() || null;

  if (Object.keys(patch).length === 0) {
    return Response.json({ success: false, error: "변경할 값이 없습니다" }, { status: 400 });
  }

  try {
    await updateCompetencyApplication(id, patch);
    return Response.json({ success: true });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/competency/applications/[id] PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "갱신에 실패했습니다",
      },
      { status },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "유효하지 않은 id" }, { status: 400 });
  }

  try {
    const data = await deleteManualCompetencyApplication(id);
    return Response.json({ success: true, data });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/competency/applications/[id] DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "삭제에 실패했습니다",
      },
      { status },
    );
  }
}
