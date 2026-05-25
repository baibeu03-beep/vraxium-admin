import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  GrowthError,
  getGrowthIndicators,
  getGrowthIndicatorsInternal,
  resolveGrowthUserId,
} from "@/lib/cluster3GrowthData";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;
  const debug = request.nextUrl.searchParams.get("debug") === "1";

  try {
    const userId = await resolveGrowthUserId(legacy_user_id);
    const data = debug
      ? await getGrowthIndicatorsInternal(userId)
      : await getGrowthIndicators(userId);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/crews/:id/cluster3/growth GET]", error);
    if (error instanceof GrowthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load growth indicators",
      },
      { status: 500 },
    );
  }
}
