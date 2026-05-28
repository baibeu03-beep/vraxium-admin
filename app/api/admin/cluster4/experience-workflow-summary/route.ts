import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { getExperienceWorkflowSummary } from "@/lib/adminExperienceDraftData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const weekId = sp.get("week_id")?.trim() || null;

  if (!weekId) {
    return Response.json(
      { success: false, error: "week_id query parameter is required" },
      { status: 400 },
    );
  }

  const organization = sp.get("organization")?.trim() || null;

  try {
    const summary = await getExperienceWorkflowSummary(weekId, organization);
    return Response.json({ success: true, data: summary });
  } catch (error) {
    console.error("[experience-workflow-summary GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
