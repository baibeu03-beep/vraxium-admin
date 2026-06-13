import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;

  try {
    const crews = await listCrewsForTargetSelection({
      organization: params.get("organization")?.trim() || null,
      team: params.get("team")?.trim() || null,
      part: params.get("part")?.trim() || null,
      membershipLevel: params.get("membershipLevel")?.trim() || null,
      status: params.get("status")?.trim() || null,
      search: params.get("q")?.trim() || null,
      mode: parseScopeMode(params.get("mode")),
    });
    return Response.json({ success: true, data: crews });
  } catch (error) {
    console.error("[admin/cluster4/crews GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
