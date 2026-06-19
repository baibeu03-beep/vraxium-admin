import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { searchUserProfiles } from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
  if (!query) {
    return Response.json({ success: true, data: [] });
  }

  try {
    const data = await searchUserProfiles(
      query,
      parseScopeMode(request.nextUrl.searchParams.get("mode")),
    );
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/user-profiles GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to search user_profiles",
      },
      { status: 500 },
    );
  }
}
