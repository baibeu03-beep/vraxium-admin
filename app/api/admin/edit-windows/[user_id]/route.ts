import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EditWindowError,
  closeEditWindow,
  upsertEditWindow,
} from "@/lib/adminEditWindowsData";
import { isEditableResourceKey } from "@/lib/adminEditWindowsTypes";

type Ctx = { params: Promise<{ user_id: string }> };

// PATCH 두 가지 모드를 한 endpoint 에서 처리:
//   1) { resource_key, action: "close" }                              → close
//   2) { resource_key, opened_at, expires_at, note? }                 → upsert
// 첫 케이스는 row 가 있을 때만 의미가 있다 (없으면 noop).
export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const resourceKey = typeof input.resource_key === "string" ? input.resource_key : "";
  if (!isEditableResourceKey(resourceKey)) {
    return Response.json(
      { success: false, error: `Unknown resource_key: ${resourceKey || "(missing)"}` },
      { status: 400 },
    );
  }

  // ── close ──
  if (input.action === "close") {
    try {
      const closed = await closeEditWindow(user_id, resourceKey);
      return Response.json({ success: true, data: { window: closed } });
    } catch (error) {
      if (error instanceof EditWindowError) {
        return Response.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      console.error("[admin/edit-windows/:user_id PATCH close]", error);
      return Response.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to close edit window",
        },
        { status: 500 },
      );
    }
  }

  // ── upsert ──
  const openedAtRaw = input.opened_at;
  const expiresAtRaw = input.expires_at;
  if (typeof openedAtRaw !== "string" || typeof expiresAtRaw !== "string") {
    return Response.json(
      { success: false, error: "opened_at and expires_at are required strings" },
      { status: 400 },
    );
  }

  const openedAt = new Date(openedAtRaw);
  const expiresAt = new Date(expiresAtRaw);

  let note: string | null = null;
  if (input.note !== undefined) {
    if (input.note === null) {
      note = null;
    } else if (typeof input.note === "string") {
      const trimmed = input.note.trim();
      note = trimmed.length ? trimmed : null;
    } else {
      return Response.json(
        { success: false, error: "note must be a string or null" },
        { status: 400 },
      );
    }
  }

  try {
    const window = await upsertEditWindow({
      userId: user_id,
      resourceKey,
      openedAt,
      expiresAt,
      note,
      grantedBy: admin.userId ?? null,
    });
    return Response.json({ success: true, data: { window } });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/edit-windows/:user_id PATCH upsert]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to upsert edit window",
      },
      { status: 500 },
    );
  }
}
