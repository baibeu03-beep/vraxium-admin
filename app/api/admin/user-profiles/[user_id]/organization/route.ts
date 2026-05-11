import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";

const USER_PROFILE_SELECT =
  "user_id, display_name, contact_email, auth_email, organization_slug, status, created_at, updated_at";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ user_id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;
  if (!isUuid(user_id)) {
    return Response.json(
      { error: "user_id must be a UUID" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { organization_slug?: unknown } | null)?.organization_slug;
  let organizationSlug: string | null;
  if (raw === null) {
    organizationSlug = null;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    organizationSlug = trimmed.length ? trimmed : null;
  } else {
    return Response.json(
      { error: "organization_slug must be a string or null" },
      { status: 400 },
    );
  }

  if (organizationSlug !== null) {
    const { data: org, error: orgError } = await supabaseAdmin
      .from("organizations")
      .select("slug")
      .eq("slug", organizationSlug)
      .maybeSingle();

    if (orgError) {
      console.error(
        "[admin/user-profiles/:user_id/organization PATCH] org lookup",
        orgError,
      );
      return Response.json({ error: orgError.message }, { status: 500 });
    }
    if (!org) {
      return Response.json(
        { error: `Unknown organization_slug: ${organizationSlug}` },
        { status: 400 },
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .update({ organization_slug: organizationSlug })
    .eq("user_id", user_id)
    .select(USER_PROFILE_SELECT)
    .single();

  if (error || !data) {
    console.error(
      "[admin/user-profiles/:user_id/organization PATCH] update",
      error,
    );
    return Response.json(
      {
        error: error?.message ?? "Failed to update user_profiles.organization_slug",
        details: error,
      },
      { status: error?.code === "PGRST116" ? 404 : 500 },
    );
  }

  return Response.json({ user_profile: data });
}
