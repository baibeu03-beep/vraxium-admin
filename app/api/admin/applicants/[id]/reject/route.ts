import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { rejectApplicant } from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

type Ctx = { params: Promise<{ id: string }> };

async function handleReject(request: Request, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  try {
    const data = await rejectApplicant(
      id,
      parseScopeMode(new URL(request.url).searchParams.get("mode")),
    );
    return Response.json({ success: true, data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reject applicant";
    const status =
      message.includes("not found") ? 404 : message.includes("Only pending") ? 409 : 400;

    console.error("[admin/applicants/:id/reject]", error);
    return Response.json({ success: false, error: message }, { status });
  }
}

export async function POST(_request: Request, ctx: Ctx) {
  return handleReject(_request, ctx);
}

export async function PATCH(_request: Request, ctx: Ctx) {
  return handleReject(_request, ctx);
}
