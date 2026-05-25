// Browser-safe constants and types for the "app users" admin view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

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
  status?: AppUserStatus | null;
  limit?: number;
};

export function isAppUserStatus(value: string | null): value is AppUserStatus {
  return Boolean(value && APP_USER_STATUSES.includes(value as AppUserStatus));
}
