// /api/admin/processes/line-groups/[id] — 프로세스 라인급 삭제.
//   DELETE — 산하 액트 존재 시 차단(409, 시안 팝업 문구). 액트 0개일 때만 hard delete.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import {
  ProcessMasterError,
  deleteProcessLineGroup,
} from "@/lib/adminProcessesData";

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
    await deleteProcessLineGroup(id);
    return Response.json({ success: true });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/line-groups/[id] DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
