import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { approveApplicant } from "@/lib/adminApplicantData";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
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
    const data = await approveApplicant(id, userId);
    return Response.json({ success: true, data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to approve applicant";
    const status =
      message.includes("not found")
        ? 404
        : message.includes("already") || message.includes("Only pending")
          ? 409
          : 400;

    console.error("[admin/applicants/:id/approve POST]", error);
    return Response.json({ success: false, error: message }, { status });
  }
}
