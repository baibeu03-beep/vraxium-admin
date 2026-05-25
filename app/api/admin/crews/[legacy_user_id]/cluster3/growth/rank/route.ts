import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { GrowthError, resolveGrowthUserId } from "@/lib/cluster3GrowthData";
import { getClubRank } from "@/lib/cluster3ClubRankData";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
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
    const data = await getClubRank(userId);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/crews/:id/cluster3/growth/rank GET]", error);
    if (error instanceof GrowthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load club rank",
      },
      { status: 500 },
    );
  }
}
