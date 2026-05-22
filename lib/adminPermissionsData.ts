import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  USER_FACING_ROLES,
  isPermissionAction,
  isUserFacingRole,
  type PermissionDto,
  type PermissionsMatrixDto,
  type RoleMatrix,
  type RolePermissionDto,
  type UserFacingRole,
} from "@/lib/adminPermissionsTypes";

// /admin/settings/permissions 전용 server-only 데이터 레이어.
// canonical 테이블:
//   public.permissions             (PK key)
//   public.role_permissions        (PK role,permission_key — 행 없음 = OFF)
//   public.role_permissions_audit  (append-only)

// Browser-safe constants/types 는 lib/adminPermissionsTypes.ts 에서 import 한 뒤
// 다시 export 한다 — 호출부가 데이터 레이어 한 곳에서 모두 가져갈 수 있도록.
export {
  USER_FACING_ROLES,
  isPermissionAction,
  isUserFacingRole,
};
export type {
  PermissionDto,
  PermissionsMatrixDto,
  RoleMatrix,
  RolePermissionDto,
  UserFacingRole,
};

export class PermissionsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PermissionsError";
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Row types — DB select 결과를 1:1 로 받는 internal shape.
// ─────────────────────────────────────────────────────────────────────
type PermissionRow = {
  key: string;
  cluster: string;
  resource: string;
  action: string;
  label: string;
  description: string | null;
  requires_edit_window: boolean;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
};

type RolePermissionRow = {
  role: string;
  permission_key: string;
  is_allowed: boolean;
  updated_by: string | null;
  updated_at: string | null;
};

const PERMISSION_SELECT =
  "key,cluster,resource,action,label,description,requires_edit_window,sort_order,created_at,updated_at";

const ROLE_PERMISSION_SELECT =
  "role,permission_key,is_allowed,updated_by,updated_at";

function toPermissionDto(row: PermissionRow): PermissionDto {
  if (!isPermissionAction(row.action)) {
    // DB CHECK 가 막아주지만, 타입 narrow 를 위해 방어적으로 throw.
    throw new PermissionsError(
      500,
      `permissions.action invalid: ${row.action}`,
    );
  }
  return {
    key: row.key,
    cluster: row.cluster,
    resource: row.resource,
    action: row.action,
    label: row.label,
    description: row.description,
    requiresEditWindow: row.requires_edit_window,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRolePermissionDto(row: RolePermissionRow): RolePermissionDto {
  if (!isUserFacingRole(row.role)) {
    throw new PermissionsError(
      500,
      `role_permissions.role invalid: ${row.role}`,
    );
  }
  return {
    role: row.role,
    permissionKey: row.permission_key,
    isAllowed: row.is_allowed,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────
// LIST: 카탈로그 + 매트릭스 한 번에 조회.
// 행 없음 = OFF 규칙은 buildRoleMatrix 에서 명시적으로 처리하지 않는다 —
// matrix[key]?.[role] === true 만 ON, 그 외(undefined/false) 는 모두 OFF.
// ─────────────────────────────────────────────────────────────────────
export async function listPermissions(): Promise<PermissionDto[]> {
  const { data, error } = await supabaseAdmin
    .from("permissions")
    .select(PERMISSION_SELECT)
    .order("sort_order", { ascending: true })
    .order("key", { ascending: true });

  if (error) throw new PermissionsError(500, error.message);
  return ((data ?? []) as unknown as PermissionRow[]).map(toPermissionDto);
}

export async function listRolePermissions(): Promise<RolePermissionDto[]> {
  const { data, error } = await supabaseAdmin
    .from("role_permissions")
    .select(ROLE_PERMISSION_SELECT);

  if (error) throw new PermissionsError(500, error.message);
  return ((data ?? []) as unknown as RolePermissionRow[]).map(toRolePermissionDto);
}

export function buildRoleMatrix(rows: RolePermissionDto[]): RoleMatrix {
  const matrix: RoleMatrix = {};
  for (const row of rows) {
    const bucket = matrix[row.permissionKey] ?? {};
    bucket[row.role] = row.isAllowed;
    matrix[row.permissionKey] = bucket;
  }
  return matrix;
}

export async function getPermissionsMatrix(options: {
  isSuperAdmin: boolean;
}): Promise<PermissionsMatrixDto> {
  const [permissions, rolePerms] = await Promise.all([
    listPermissions(),
    listRolePermissions(),
  ]);
  return {
    permissions,
    roles: USER_FACING_ROLES,
    matrix: buildRoleMatrix(rolePerms),
    isSuperAdmin: options.isSuperAdmin,
  };
}

// ─────────────────────────────────────────────────────────────────────
// UPSERT: 한 (role, permission_key) 셀의 is_allowed 를 설정.
//   - permission_key 존재 확인 (FK 위반 시 친절한 메시지)
//   - old value 조회 → audit 에 함께 기록
//   - upsert 후 audit insert (audit 실패는 toggle 실패로 전파하지 않음)
// ─────────────────────────────────────────────────────────────────────
export type SetRolePermissionInput = {
  permissionKey: string;
  role: UserFacingRole;
  isAllowed: boolean;
  changedBy: string; // admin_users.id (= auth.users.id)
  reason: string | null;
};

export async function setRolePermission(
  input: SetRolePermissionInput,
): Promise<RolePermissionDto> {
  if (!isUserFacingRole(input.role)) {
    throw new PermissionsError(400, `Unknown role: ${input.role}`);
  }
  if (typeof input.permissionKey !== "string" || input.permissionKey.length === 0) {
    throw new PermissionsError(400, "permission key is required");
  }
  if (!input.changedBy) {
    throw new PermissionsError(400, "changedBy is required");
  }

  // 1) permission_key 존재 확인
  const { data: permRow, error: permErr } = await supabaseAdmin
    .from("permissions")
    .select("key")
    .eq("key", input.permissionKey)
    .maybeSingle();
  if (permErr) throw new PermissionsError(500, permErr.message);
  if (!permRow) {
    throw new PermissionsError(
      404,
      `Unknown permission key: ${input.permissionKey}`,
    );
  }

  // 2) 기존 값 조회 (audit 용)
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("role_permissions")
    .select(ROLE_PERMISSION_SELECT)
    .eq("role", input.role)
    .eq("permission_key", input.permissionKey)
    .maybeSingle();
  if (selErr) throw new PermissionsError(500, selErr.message);

  const oldIsAllowed = existing
    ? (existing as unknown as RolePermissionRow).is_allowed
    : null;

  // 3) upsert
  const { data: upserted, error: upErr } = await supabaseAdmin
    .from("role_permissions")
    .upsert(
      {
        role: input.role,
        permission_key: input.permissionKey,
        is_allowed: input.isAllowed,
        updated_by: input.changedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "role,permission_key" },
    )
    .select(ROLE_PERMISSION_SELECT)
    .single();

  if (upErr || !upserted) {
    throw new PermissionsError(
      500,
      upErr?.message ?? "Failed to upsert role_permissions",
    );
  }

  // 4) audit insert — 실패해도 toggle 자체는 성공 처리 (감사 누락은 log 만 남김).
  const { error: auditErr } = await supabaseAdmin
    .from("role_permissions_audit")
    .insert({
      role: input.role,
      permission_key: input.permissionKey,
      old_is_allowed: oldIsAllowed,
      new_is_allowed: input.isAllowed,
      changed_by: input.changedBy,
      reason: input.reason,
    });
  if (auditErr) {
    console.error("[setRolePermission] audit insert failed", {
      role: input.role,
      permissionKey: input.permissionKey,
      changedBy: input.changedBy,
      error: auditErr.message,
    });
  }

  return toRolePermissionDto(upserted as unknown as RolePermissionRow);
}
