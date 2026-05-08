import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isApplicantStatus, listApplicants } from "@/lib/adminApplicantData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const statusParam = request.nextUrl.searchParams.get("status");
  if (statusParam && !isApplicantStatus(statusParam)) {
    return Response.json(
      { success: false, error: `Unknown applicant status: ${statusParam}` },
      { status: 400 },
    );
  }

  try {
    const status = isApplicantStatus(statusParam) ? statusParam : undefined;
    const data = await listApplicants(status);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/applicants GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load applicants",
      },
      { status: 500 },
    );
  }
}
