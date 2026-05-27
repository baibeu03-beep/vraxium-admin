import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type TeamRow = {
  id: string;
  team_name: string;
  organization_slug: string;
  is_active: boolean;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org =
    request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    let query = supabaseAdmin
      .from("cluster4_teams")
      .select("id,team_name,organization_slug,is_active")
      .eq("is_active", true)
      .order("team_name", { ascending: true });

    if (org) {
      query = query.eq("organization_slug", org);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[admin/cluster4/teams GET] query error", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    const teams = ((data ?? []) as TeamRow[]).map((t) => ({
      id: t.id,
      teamName: t.team_name,
      organizationSlug: t.organization_slug,
      isActive: t.is_active,
    }));

    return Response.json({ success: true, data: teams });
  } catch (error) {
    console.error("[admin/cluster4/teams GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list teams",
      },
      { status: 500 },
    );
  }
}
