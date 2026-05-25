import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { GrowthError, resolveGrowthUserId } from "@/lib/cluster3GrowthData";
import { syncGradeStats } from "@/lib/cluster3ClubRankData";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  try {
    const userId = await resolveGrowthUserId(legacy_user_id);
    const result = await syncGradeStats(userId);
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[admin/crews/:id/cluster3/growth/rank/sync POST]", error);
    if (error instanceof GrowthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to sync grade stats",
      },
      { status: 500 },
    );
  }
}
