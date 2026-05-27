import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  profile_photo_url: string | null;
  organization_slug: string | null;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    // TODO: organization 필터 보강 — 현재는 organization_slug 기반 필터.
    //       admin_users 와 user_profiles 의 조직 매핑이 확정되면
    //       어드민 소속 조직만 노출하도록 제한.
    let query = supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,profile_photo_url,organization_slug")
      .order("display_name", { ascending: true });

    if (org) {
      query = query.eq("organization_slug", org);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[admin/cluster4/users GET] query error", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    const users = ((data ?? []) as UserProfileRow[]).map((u) => ({
      userId: u.user_id,
      displayName: u.display_name ?? "(이름 없음)",
      profileImg: u.profile_photo_url,
      organization: u.organization_slug,
    }));

    return Response.json({ success: true, data: users });
  } catch (error) {
    console.error("[admin/cluster4/users GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list users",
      },
      { status: 500 },
    );
  }
}
