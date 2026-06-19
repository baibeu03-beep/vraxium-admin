import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listCluster4Users } from "@/lib/adminCluster4UsersData";
import { resolveRequestScope } from "@/lib/userScope";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const organization =
    request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    const scope = await resolveRequestScope(request);
    const users = await listCluster4Users({
      organization,
      mode: scope.mode,
    });
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
