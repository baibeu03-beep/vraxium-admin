import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;
  try {
    const dto = await getWeeklyGrowth(legacy_user_id);
    if (!dto) {
      return Response.json(
        { success: false, error: "Crew not found" },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: dto });
  } catch (error) {
    console.error(
      "[admin/crews/:legacy_user_id/cluster4/weekly-growth GET]",
      error,
    );
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load weekly growth data",
      },
      { status: 500 },
    );
  }
}
