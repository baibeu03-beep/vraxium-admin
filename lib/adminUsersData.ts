import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ADMIN_READ_ROLES, type AdminRole } from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";

// admin_users 읽기 전용 목록.
// 운영자가 "관리자 계정"을 한눈에 확인하려고 사용하는 뷰.
//
// admin_users.id 는 auth.users.id 와 동일한 uuid (requireAdmin이 그것으로 join 한다).

export type AdminUserDto = {
  id: string;
  email: string | null;
  role: string | null;
  isActive: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const ADMIN_USER_SELECT = [
  "id",
  "email",
  "role",
  "is_active",
  "created_at",
  "updated_at",
].join(",");

type AdminUserRow = {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

function toDto(row: AdminUserRow): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

export type ListAdminUsersOptions = {
  query?: string | null;
  role?: AdminRole | null;
  isActive?: boolean | null;
};

export function isAdminUserRole(value: string | null): value is AdminRole {
  return Boolean(value && (ADMIN_READ_ROLES as readonly string[]).includes(value));
}

export async function listAdminUsers(
  options: ListAdminUsersOptions = {},
): Promise<AdminUserDto[]> {
  let queryBuilder = supabaseAdmin
    .from("admin_users")
    .select(ADMIN_USER_SELECT)
    .order("created_at", { ascending: false, nullsFirst: false });

  if (options.role) {
    queryBuilder = queryBuilder.eq("role", options.role);
  }
  if (options.isActive !== null && options.isActive !== undefined) {
    queryBuilder = queryBuilder.eq("is_active", options.isActive);
  }

  const rawQuery = options.query?.trim() ?? "";
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed ? [`email.ilike.%${trimmed}%`, `role.ilike.%${trimmed}%`] : []),
    ...(isUuid(rawQuery) ? [`id.eq.${rawQuery}`] : []),
  ];

  if (filters.length > 0) {
    queryBuilder = queryBuilder.or(
      filters.join(","),
    );
  }

  const { data, error } = await queryBuilder;
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as AdminUserRow[]).map(toDto);
}
