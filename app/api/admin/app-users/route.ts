import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isAccountStatus, listAppUsers } from "@/lib/adminAppUsersData";
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
  const statusParam = params.get("status");
  if (statusParam && !isAccountStatus(statusParam)) {
    return Response.json(
      { success: false, error: `Unknown account status: ${statusParam}` },
      { status: 400 },
    );
  }

  const queryParam = params.get("query")?.trim() ?? null;

  try {
    const result = await listAppUsers({
      query: queryParam,
      status: isAccountStatus(statusParam) ? statusParam : null,
      mode: parseScopeMode(params.get("mode")),
    });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error("[admin/app-users GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load app users",
      },
      { status: 500 },
    );
  }
}
