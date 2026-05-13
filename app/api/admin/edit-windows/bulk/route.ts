import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EditWindowError,
  closeEditWindowsBulk,
  listMatchingEditWindowUserIds,
  upsertEditWindowsBulk,
} from "@/lib/adminEditWindowsData";
import { isEditableResourceKey } from "@/lib/adminEditWindowsTypes";

function parseUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string");
}

function parseNote(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length ? trimmed : null;
}

export async function POST(request: NextRequest) {
  let admin;
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

  try {
    let userIds = parseUserIds(input.user_ids);
    if (input.select_all_matching === true) {
      const filters = input.filters && typeof input.filters === "object"
        ? (input.filters as Record<string, unknown>)
        : {};
      userIds = await listMatchingEditWindowUserIds({
        resourceKey,
        query: typeof filters.q === "string" ? filters.q : null,
      });
    }

    userIds = Array.from(new Set(userIds));
    if (userIds.length === 0) {
      return Response.json(
        { success: false, error: "No user_ids selected" },
        { status: 400 },
      );
    }

    if (input.action === "close") {
      const windows = await closeEditWindowsBulk(userIds, resourceKey);
      return Response.json({
        success: true,
        data: { count: userIds.length, windows },
      });
    }

    if (typeof input.opened_at !== "string" || typeof input.expires_at !== "string") {
      return Response.json(
        { success: false, error: "opened_at and expires_at are required strings" },
        { status: 400 },
      );
    }

    const windows = await upsertEditWindowsBulk({
      userIds,
      resourceKey,
      openedAt: new Date(input.opened_at),
      expiresAt: new Date(input.expires_at),
      note: parseNote(input.note),
      grantedBy: admin.userId ?? null,
    });

    return Response.json({
      success: true,
      data: { count: userIds.length, windows },
    });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/edit-windows/bulk POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to bulk update edit windows",
      },
      { status: 500 },
    );
  }
}
