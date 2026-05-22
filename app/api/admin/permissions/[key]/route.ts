import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  PermissionsError,
  isUserFacingRole,
  setRolePermission,
} from "@/lib/adminPermissionsData";

// admin_users.role='owner' = logical super_admin.
// 권한 매트릭스 수정은 super_admin 단독.
// (라벨 매핑은 본 게이트 한 곳에서만 일어난다 — 향후 라벨 교체 시 단일 지점 수정.)
const SUPER_ADMIN_ROLES = ["owner"] as const;

type Ctx = { params: Promise<{ key: string }> };

// PATCH /api/admin/permissions/[key]
// body: { role: UserFacingRole, is_allowed: boolean, reason?: string | null }
// → (role, key) 셀의 is_allowed 를 설정하고 audit 한 행을 남긴다.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(SUPER_ADMIN_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { key } = await params;
  if (typeof key !== "string" || key.length === 0) {
    return Response.json(
      { success: false, error: "permission key is required" },
      { status: 400 },
    );
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

  const rawRole = input.role;
  if (!isUserFacingRole(rawRole)) {
    return Response.json(
      { success: false, error: `Unknown role: ${String(rawRole)}` },
      { status: 400 },
    );
  }

  const rawIsAllowed = input.is_allowed;
  if (typeof rawIsAllowed !== "boolean") {
    return Response.json(
      { success: false, error: "is_allowed must be a boolean" },
      { status: 400 },
    );
  }

  let reason: string | null = null;
  if (input.reason !== undefined) {
    if (input.reason === null) {
      reason = null;
    } else if (typeof input.reason === "string") {
      const trimmed = input.reason.trim();
      reason = trimmed.length > 0 ? trimmed : null;
    } else {
      return Response.json(
        { success: false, error: "reason must be a string or null" },
        { status: 400 },
      );
    }
  }

  try {
    const updated = await setRolePermission({
      permissionKey: key,
      role: rawRole,
      isAllowed: rawIsAllowed,
      changedBy: admin.userId,
      reason,
    });
    return Response.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof PermissionsError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/permissions/:key PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update permission",
      },
      { status: 500 },
    );
  }
}
