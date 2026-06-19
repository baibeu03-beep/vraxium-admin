import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import {
  ACCOUNT_STATUSES,
  isAccountStatus,
  APP_USER_STATUSES,
  isAppUserStatus,
  type AccountStatus,
  type AdminAppUserDto,
  type AppUserStatus,
  type ListAppUsersOptions,
  type AdminAppUsersResult,
} from "@/lib/adminAppUsersTypes";

// user_profiles 읽기 전용 목록.
// 어드민 운영자가 "가입된 사용자"를 한눈에 확인하려고 사용하는 뷰이므로
// /api/admin/user-profiles 의 검색 전용 endpoint와는 별도로 둔다 (그쪽은
// applicant 연결 검색 전용으로 limit 20).
//
// 모든 user_profiles 컬럼을 반환하지 않고, 화면에 보여줄 컬럼만 select 한다.
//
// Pure constants/types live in lib/adminAppUsersTypes.ts so client components
// can import them without pulling supabaseAdmin into the browser bundle
// (which would crash with "supabaseKey is required" since
// SUPABASE_SERVICE_ROLE_KEY is server-only).

export {
  ACCOUNT_STATUSES,
  isAccountStatus,
  APP_USER_STATUSES,
  isAppUserStatus,
  type AccountStatus,
  type AdminAppUserDto,
  type AppUserStatus,
  type ListAppUsersOptions,
  type AdminAppUsersResult,
};

const APP_USER_SELECT = [
  "user_id",
  "display_name",
  "contact_email",
  "auth_email",
  "organization_slug",
  "status",
  "created_at",
  "updated_at",
].join(",");

type AppUserRow = {
  user_id: string;
  display_name: string | null;
  contact_email: string | null;
  auth_email: string | null;
  organization_slug: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function toDto(row: AppUserRow): AdminAppUserDto {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    contactEmail: row.contact_email,
    authEmail: row.auth_email,
    organizationSlug: row.organization_slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

export async function listAppUsers(
  options: ListAppUsersOptions = {},
): Promise<AdminAppUsersResult> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const scope = await resolveUserScope(options.mode ?? "operating", null);

  let queryBuilder = supabaseAdmin
    .from("user_profiles")
    .select(APP_USER_SELECT, { count: "exact" })
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  // super admin 은 사용자 목록에서 제외 (목록 노출에서만 숨김).
  queryBuilder = excludeSuperAdmins(queryBuilder);

  if (scope.mode === "test") {
    const ids = scope.includeUserIds ?? [];
    if (ids.length === 0) {
      return { data: [], total: 0, displayedCount: 0, limit };
    }
    queryBuilder = queryBuilder.in("user_id", ids);
  } else if (scope.excludeUserIds.length > 0) {
    queryBuilder = queryBuilder.not(
      "user_id",
      "in",
      `(${scope.excludeUserIds.join(",")})`,
    );
  }

  if (options.status) {
    queryBuilder = queryBuilder.eq("status", options.status);
  }

  const rawQuery = options.query?.trim() ?? "";
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
          `organization_slug.ilike.%${trimmed}%`,
        ]
      : []),
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];

  if (filters.length > 0) {
    queryBuilder = queryBuilder.or(
      filters.join(","),
    );
  }

  const { data, error, count } = await queryBuilder;
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown as AppUserRow[]).map(toDto);
  return {
    data: rows,
    total: count ?? rows.length,
    displayedCount: rows.length,
    limit,
  };
}
