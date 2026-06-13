import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { parseScopeMode } from "@/lib/userScopeShared";

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
  // 모집단 모드(operating 기본 / test). 팀 목록도 분기: operating=운영 팀만, test=(T) 테스트 팀만.
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

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

    const teams = ((data ?? []) as TeamRow[])
      // 테스트 팀 레지스트리(isTestTeam) 기준 mode 필터: operating=운영 팀만 / test=(T) 팀만.
      .filter((t) =>
        mode === "test"
          ? isTestTeam(t.organization_slug, t.team_name)
          : !isTestTeam(t.organization_slug, t.team_name),
      )
      .map((t) => ({
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
