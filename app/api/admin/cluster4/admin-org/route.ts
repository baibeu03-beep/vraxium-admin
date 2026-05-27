import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { getAdminOrganization } from "@/lib/adminExperienceLineData";

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const org = await getAdminOrganization(admin.userId);
    return Response.json({ success: true, data: { organization: org } });
  } catch (error) {
    console.error("[admin/cluster4/admin-org GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
