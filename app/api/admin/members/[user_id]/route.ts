import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  MemberPatchError,
  pickMemberPatch,
  updateMember,
} from "@/lib/adminMembersData";
import { isOrganizationSlug } from "@/lib/organizations";

type Ctx = { params: Promise<{ user_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = admin.userId;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  let patch;
  try {
    patch = pickMemberPatch(body);
  } catch (error) {
    if (error instanceof MemberPatchError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }

  // organization_slug 는 ORGANIZATIONS whitelist 또는 null 만 허용.
  if (Object.prototype.hasOwnProperty.call(patch, "organization_slug")) {
    const slug = patch.organization_slug;
    if (slug !== null && !isOrganizationSlug(slug)) {
      return Response.json(
        { success: false, error: `Unknown organization_slug: ${slug}` },
        { status: 400 },
      );
    }
  }

  try {
    const member = await updateMember(user_id, patch, actorId);
    return Response.json({ success: true, data: member });
  } catch (error) {
    if (error instanceof MemberPatchError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/members/:user_id PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update member",
      },
      { status: 500 },
    );
  }
}
