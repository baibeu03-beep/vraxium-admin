import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { GrowthError } from "@/lib/cluster3GrowthData";
import { syncAllGradeStats } from "@/lib/cluster3ClubRankData";

export async function POST() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const data = await syncAllGradeStats();
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/sync/grade-stats POST]", error);
    if (error instanceof GrowthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to sync all grade stats",
      },
      { status: 500 },
    );
  }
}
