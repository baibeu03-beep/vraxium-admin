import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { linkApplicantToUserProfile } from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const userId = (body as { userId?: unknown })?.userId;
  if (!userId || typeof userId !== "string") {
    return Response.json(
      { success: false, error: "userId is required" },
      { status: 400 },
    );
  }

  try {
    const data = await linkApplicantToUserProfile(
      id,
      userId,
      parseScopeMode(request.nextUrl.searchParams.get("mode")),
    );
    return Response.json({ success: true, data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to link applicant";
    const status =
      message.includes("not found") ? 404 : message.includes("already") || message.includes("Only pending") ? 409 : 400;

    console.error("[admin/applicants/:id/link PATCH]", error);
    return Response.json({ success: false, error: message }, { status });
  }
}
