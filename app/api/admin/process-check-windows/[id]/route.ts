import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  ProcessCheckWindowError,
  deleteProcessCheckWindow,
  setProcessCheckWindowActive,
} from "@/lib/processCheckWindowsData";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/process-check-windows/[id]  body: { is_active: boolean }
//   예외 활성/비활성 토글. 비활성 = 판정에서 제외(행 보존) → 드롭다운에서 다시 빠진다.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }
  const isActive = (body as Record<string, unknown>).is_active;
  if (typeof isActive !== "boolean") {
    return Response.json(
      { success: false, error: "is_active (boolean) is required" },
      { status: 400 },
    );
  }

  try {
    await setProcessCheckWindowActive(id, isActive);
    return Response.json({ success: true, data: { id, isActive } });
  } catch (error) {
    if (error instanceof ProcessCheckWindowError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/process-check-windows/:id PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update window" },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/process-check-windows/[id]
//   예외 영구 삭제. 삭제 즉시 해당 주차는 기본 정책만 따른다(드롭다운에서 제외).
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  try {
    await deleteProcessCheckWindow(id);
    return Response.json({ success: true, data: { id, deleted: true } });
  } catch (error) {
    if (error instanceof ProcessCheckWindowError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/process-check-windows/:id DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete window" },
      { status: 500 },
    );
  }
}
