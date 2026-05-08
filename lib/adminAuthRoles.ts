// Browser-safe role constants for admin auth.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

export const ADMIN_READ_ROLES = ["owner", "admin", "viewer"] as const;
export const ADMIN_WRITE_ROLES = ["owner", "admin"] as const;

export type AdminRole = (typeof ADMIN_READ_ROLES)[number];
