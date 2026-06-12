// /api/admin/processes/acts/[id] — 액트 삭제 (프로세스 정보 화면).
//   DELETE — 마스터 액트 hard delete. 라인급 삭제 차단(산하 액트)과 무관하게 개별 액트는 삭제 가능.
//   snapshot/주차 성장 계산 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { ProcessMasterError, deleteProcessAct } from "@/lib/adminProcessesData";

type Ctx = { params: Promise<{ id: string }> };

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
    await deleteProcessAct(id);
    return Response.json({ success: true });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/acts/[id] DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
