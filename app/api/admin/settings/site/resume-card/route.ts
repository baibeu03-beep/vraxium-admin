import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  getSiteResumeCard,
  patchSiteResumeCard,
  ResumeCardError,
} from "@/lib/adminResumeCardData";

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const data = await getSiteResumeCard();
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/settings/site/resume-card GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load site resume-card settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const data = await patchSiteResumeCard(body);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/settings/site/resume-card PATCH]", error);
    if (error instanceof ResumeCardError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update site resume-card settings",
      },
      { status: 500 },
    );
  }
}
