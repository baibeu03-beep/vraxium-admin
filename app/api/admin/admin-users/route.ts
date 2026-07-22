import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isAdminUserRole, listAdminUsers } from "@/lib/adminUsersData";
import { publicErrorMessage } from "@/lib/apiError";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const roleParam = params.get("role");
  if (roleParam && !isAdminUserRole(roleParam)) {
    return Response.json(
      { success: false, error: `Unknown admin role: ${roleParam}` },
      { status: 400 },
    );
  }

  const activeParam = params.get("active");
  let isActive: boolean | null = null;
  if (activeParam === "true") isActive = true;
  else if (activeParam === "false") isActive = false;
  else if (activeParam !== null && activeParam !== "") {
    return Response.json(
      { success: false, error: `Unknown active filter: ${activeParam}` },
      { status: 400 },
    );
  }

  const queryParam = params.get("query")?.trim() ?? null;

  try {
    const data = await listAdminUsers({
      query: queryParam,
      role: isAdminUserRole(roleParam) ? roleParam : null,
      isActive,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/admin-users GET]", error);
    return Response.json(
      {
        success: false,
        error:
          publicErrorMessage(error, 500, "운영 계정 목록을 불러오지 못했습니다."),
      },
      { status: 500 },
    );
  }
}
