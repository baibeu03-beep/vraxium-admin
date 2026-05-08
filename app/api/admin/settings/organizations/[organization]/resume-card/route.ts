import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  getOrganizationResumeCard,
  patchOrganizationResumeCard,
  ResumeCardError,
} from "@/lib/adminResumeCardData";
import { isOrganizationSlug } from "@/lib/organizations";

type Ctx = { params: Promise<{ organization: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { organization } = await params;
  if (!isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${organization}` },
      { status: 400 },
    );
  }

  try {
    const data = await getOrganizationResumeCard(organization);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error(
      "[admin/settings/organizations/:organization/resume-card GET]",
      error,
    );
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load organization resume-card settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { organization } = await params;
  if (!isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${organization}` },
      { status: 400 },
    );
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
    const data = await patchOrganizationResumeCard(organization, body);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error(
      "[admin/settings/organizations/:organization/resume-card PATCH]",
      error,
    );
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
            : "Failed to update organization resume-card settings",
      },
      { status: 500 },
    );
  }
}
