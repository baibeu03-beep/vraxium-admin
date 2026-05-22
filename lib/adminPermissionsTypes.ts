// Browser-safe constants and types for the /admin/settings/permissions view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components will import from here.
//
// canonical 테이블: public.permissions / public.role_permissions / public.role_permissions_audit
// (db/migrations/2026-05-22_permissions_matrix_step1_tables.sql)

// ─────────────────────────────────────────────────────────────────────
// User-facing role 7종 — DB 의 role_permissions_role_check 와 1:1 일치.
// admin / super_admin 은 application 의 logical role.
//   super_admin 은 admin_users.role='owner' 와 logical 매핑되며 (API gate 단에서 처리),
//   본 테이블에는 'super_admin' 문자열 그대로 저장된다.
// ─────────────────────────────────────────────────────────────────────
export const USER_FACING_ROLES = [
  "crew",
  "ambassador",
  "agent",
  "part_leader",
  "team_leader",
  "admin",
  "super_admin",
] as const;

export type UserFacingRole = (typeof USER_FACING_ROLES)[number];

export function isUserFacingRole(value: unknown): value is UserFacingRole {
  return (
    typeof value === "string" &&
    (USER_FACING_ROLES as readonly string[]).includes(value)
  );
}

// 어드민/멤버 화면 드롭다운 통일 라벨 (정책: 2026-05-22).
// admin_users.role 의 owner/admin/viewer 와 의미가 겹치는 super_admin/admin 은
// 같은 라벨("최고 관리자"/"관리자") 을 공유한다 — admin_users 라벨 매핑은
// lib/adminAccountsTypes.ts:ADMIN_USERS_ROLE_LABELS 에서 별도 유지.
export const USER_FACING_ROLE_LABELS: Record<UserFacingRole, string> = {
  super_admin: "최고 관리자",
  admin: "관리자",
  agent: "에이전트",
  ambassador: "앰배서더",
  part_leader: "파트장",
  team_leader: "팀장",
  crew: "크루",
};

// ─────────────────────────────────────────────────────────────────────
// Permission action — public.permissions.action CHECK 와 일치.
// ─────────────────────────────────────────────────────────────────────
export const PERMISSION_ACTIONS = ["view", "edit"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "view" || value === "edit";
}

// ─────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────
export type PermissionDto = {
  key: string;
  cluster: string;
  resource: string;
  action: PermissionAction;
  label: string;
  description: string | null;
  requiresEditWindow: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RolePermissionDto = {
  role: UserFacingRole;
  permissionKey: string;
  isAllowed: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

// matrix[permission_key][role] = true|false.
// 키가 빠져 있으면 OFF 로 해석한다 (DB 행 없음 = OFF 규칙).
export type RoleMatrix = Record<string, Partial<Record<UserFacingRole, boolean>>>;

export type PermissionsMatrixDto = {
  permissions: PermissionDto[];
  roles: readonly UserFacingRole[];
  matrix: RoleMatrix;
  isSuperAdmin: boolean;
};

// PATCH /api/admin/permissions/[key] body
export type SetRolePermissionPayload = {
  role: UserFacingRole;
  is_allowed: boolean;
  reason?: string | null;
};
