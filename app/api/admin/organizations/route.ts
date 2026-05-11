import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("slug, name, type")
    .order("name", { ascending: true });

  if (error) {
    console.error("[admin/organizations GET]", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ organizations: data ?? [] });
}
