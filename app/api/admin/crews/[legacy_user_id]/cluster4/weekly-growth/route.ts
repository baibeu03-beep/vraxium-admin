import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
// 강화율 SoT 통일(2026-07-06): 카드 경로(breakdownFromLines)와 동일 SoT 로 노출.
import { getUnifiedWeeklyGrowth } from "@/lib/cluster4WeeklyCardsData";

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
    const dto = await getUnifiedWeeklyGrowth(legacy_user_id);
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
