// Browser-safe constants and types for /admin/settings/accounts.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.
//
// 이 페이지의 primary 데이터 출처는 public.admin_users 다.
//   - admin_users 에 row 가 있는 계정 = 어드민 페이지에 로그인 가능한 운영 계정
//   - admin_users.role 의 owner / admin / viewer 가 본 페이지의 primary role
//   - 일반 소셜 로그인 사용자(프론트 회원) 는 user_profiles 에만 존재하며 본 페이지 노출 대상이 아님
//
// user_profiles 는 부가 정보(이름·이메일·조직) 노출 + 서비스 역할(user_profiles.role)
// 동기화 용도로만 join 된다.

import {
  USER_FACING_ROLES,
  isUserFacingRole,
  type UserFacingRole,
} from "@/lib/adminPermissionsTypes";

// 서비스 역할(Cluster 권한 매트릭스 행 매칭) 은 user_profiles.role 의 7종.
// 본 페이지의 primary 는 아니지만, 운영 계정 생성/변경 시 admin_users.role 과 동기화.
export { USER_FACING_ROLES, isUserFacingRole };
export type { UserFacingRole };

// ─────────────────────────────────────────────────────────────────────
// PRIMARY role — admin_users.role 3종
//   owner  = 최고 관리자
//   admin  = 관리자
//   viewer = 조회자
// DB CHECK 제약(admin_users_role_check) 과 1:1 일치.
// ─────────────────────────────────────────────────────────────────────
export const ADMIN_USERS_ROLES = ["owner", "admin", "viewer"] as const;
export type AdminUsersRole = (typeof ADMIN_USERS_ROLES)[number];

export function isAdminUsersRole(value: unknown): value is AdminUsersRole {
  return (
    typeof value === "string" &&
    (ADMIN_USERS_ROLES as readonly string[]).includes(value)
  );
}

export const ADMIN_USERS_ROLE_LABELS: Record<AdminUsersRole, string> = {
  owner: "최고 관리자",
  admin: "관리자",
  viewer: "조회자",
};

// ─────────────────────────────────────────────────────────────────────
// 매핑: admin_users.role → user_profiles.role (서비스 역할)
//
//   owner  → 'super_admin'   (권한 매트릭스의 super_admin 행과 매칭)
//   admin  → 'admin'         (권한 매트릭스의 admin 행과 매칭)
//   viewer → null            (서비스 역할 없음 — 어드민 페이지 조회 전용)
//
// 본 매핑은 운영 계정 생성/변경 시 자동 동기화에 사용된다. user_profiles.role 의
// 나머지 5종 (crew/ambassador/agent/part_leader/team_leader) 은 본 페이지가 만들지 않는다 —
// 그쪽은 프론트 회원 가입 흐름 또는 별도 멤버 관리 페이지가 담당.
// ─────────────────────────────────────────────────────────────────────
export function userProfileRoleForAdminUsersRole(
  adminRole: AdminUsersRole,
): UserFacingRole | null {
  if (adminRole === "owner") return "super_admin";
  if (adminRole === "admin") return "admin";
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────
export type AccountDto = {
  userId: string;                       // admin_users.id (= auth.users.id)
  email: string | null;                 // admin_users.email
  adminRole: AdminUsersRole;            // PRIMARY: owner/admin/viewer
  isActive: boolean;                    // admin_users.is_active
  createdAt: string | null;             // admin_users.created_at
  updatedAt: string | null;             // admin_users.updated_at
  // user_profiles join (운영 계정 생성 시 항상 함께 만들어지므로 일반적으로 채워짐).
  displayName: string | null;
  authEmail: string | null;
  contactEmail: string | null;
  organizationSlug: string | null;
  userProfileRole: UserFacingRole | null; // SECONDARY: 동기화된 서비스 역할
};

export type ListAccountsResult = {
  accounts: AccountDto[];
  total: number;
  limit: number;
  offset: number;
  isSuperAdmin: boolean;                // admin_users.role='owner' 일 때만 true
};

// ─────────────────────────────────────────────────────────────────────
// API payloads
// ─────────────────────────────────────────────────────────────────────
export type CreateAccountPayload = {
  display_name: string;
  email: string;
  organization_slug?: string | null;
  admin_role: AdminUsersRole;           // PRIMARY (owner/admin/viewer)
  is_active?: boolean;                  // default true
  send_invite_email?: boolean;          // default false → 즉시 임시 비밀번호 발급
};

export type UpdateAccountPayload = {
  display_name?: string;
  contact_email?: string | null;
  organization_slug?: string | null;
  admin_role?: AdminUsersRole;          // role 변경 시 user_profiles.role 도 자동 동기화
  is_active?: boolean;
  reason?: string | null;               // admin_role 변경 시 audit 사유
};

export type CreateAccountResult = {
  account: AccountDto;
  temporary_password: string | null;    // invite 모드면 null
};

export type ResetPasswordResult = {
  temporary_password: string;
};
