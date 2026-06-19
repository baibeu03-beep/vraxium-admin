// Browser-safe constants and types for the "app users" admin view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

// 계정 활성 상태 전용 (user_profiles.status). 성장 상태와 분리된 단일 출처.
export const ACCOUNT_STATUSES = ["active", "inactive"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export function isAccountStatus(value: string | null): value is AccountStatus {
  return Boolean(value && (ACCOUNT_STATUSES as readonly string[]).includes(value));
}

/**
 * @deprecated 계정+성장 혼재 enum. status 필터는 ACCOUNT_STATUSES,
 *   성장 상태는 shared/growth.contracts.GROWTH_STATUSES 를 사용하세요.
 *   (잔존 호환용 — 신규 코드에서 사용 금지)
 */
export const APP_USER_STATUSES = [
  "active",
  "weekly_rest",
  "seasonal_rest",
  "paused",
  "graduated",
  "suspended",
] as const;

export type AppUserStatus = (typeof APP_USER_STATUSES)[number];

export type AdminAppUserDto = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ListAppUsersOptions = {
  query?: string | null;
  // 계정 활성 상태(active/inactive) 필터. (구: 성장값 혼재 AppUserStatus)
  status?: AccountStatus | null;
  limit?: number;
  mode?: import("@/lib/userScopeShared").ScopeMode;
};

export type AdminAppUsersResult = {
  data: AdminAppUserDto[];
  total: number;
  displayedCount: number;
  limit: number;
};

export function isAppUserStatus(value: string | null): value is AppUserStatus {
  return Boolean(value && APP_USER_STATUSES.includes(value as AppUserStatus));
}
