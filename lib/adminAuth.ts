import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  type AdminRole,
} from "@/lib/adminAuthRoles";

// Role constants/types live in lib/adminAuthRoles.ts so client components can
// import them without pulling next/headers + supabaseAdmin into the browser
// bundle.
export { ADMIN_READ_ROLES, ADMIN_WRITE_ROLES, type AdminRole };

type AdminUserRow = {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
};

export type AdminContext = {
  userId: string;
  email: string | null;
  role: AdminRole;
  isActive: true;
};

export class AdminAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

function isAdminRole(value: string | null | undefined): value is AdminRole {
  return ADMIN_READ_ROLES.includes(value as AdminRole);
}

export async function requireAdmin(allowedRoles: readonly AdminRole[] = ADMIN_READ_ROLES) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error("[requireAdmin] getUser failed", {
      error: authError?.message ?? null,
      hasUser: Boolean(user),
    });
    throw new AdminAuthError(401, "Admin authentication required.");
  }

  const { data: adminUser, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (adminError) {
    console.error("[requireAdmin] admin_users lookup failed", {
      userId: user.id,
      error: adminError.message,
    });
    throw new AdminAuthError(500, adminError.message);
  }

  if (!adminUser) {
    console.warn("[requireAdmin] admin_users missing", {
      userId: user.id,
      email: user.email ?? null,
    });
    throw new AdminAuthError(403, "Signed-in user is not an admin.");
  }

  const row = adminUser as unknown as AdminUserRow;
  if (!row.is_active) {
    console.warn("[requireAdmin] inactive admin", {
      userId: user.id,
      email: user.email ?? row.email ?? null,
      role: row.role,
    });
    throw new AdminAuthError(403, "Admin account is inactive.");
  }

  if (!isAdminRole(row.role)) {
    console.warn("[requireAdmin] invalid admin role", {
      userId: user.id,
      email: user.email ?? row.email ?? null,
      role: row.role,
    });
    throw new AdminAuthError(403, "Admin role is invalid.");
  }

  if (!allowedRoles.includes(row.role)) {
    console.warn("[requireAdmin] insufficient role", {
      userId: user.id,
      email: user.email ?? row.email ?? null,
      role: row.role,
      allowedRoles,
    });
    throw new AdminAuthError(403, "Admin role is not allowed for this action.");
  }

  return {
    userId: user.id,
    email: user.email ?? row.email,
    role: row.role,
    isActive: true,
  } satisfies AdminContext;
}

export async function requireAdminPage(
  allowedRoles: readonly AdminRole[] = ADMIN_READ_ROLES,
) {
  try {
    return await requireAdmin(allowedRoles);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      redirect("/login");
    }
    throw error;
  }
}

export function toAdminErrorResponse(error: unknown) {
  if (error instanceof AdminAuthError) {
    return Response.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }
  return null;
}
