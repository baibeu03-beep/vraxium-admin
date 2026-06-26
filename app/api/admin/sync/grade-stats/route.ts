import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { GrowthError } from "@/lib/cluster3GrowthData";
import { resyncGradeStatsBatch } from "@/lib/cluster3ClubRankData";

export async function POST() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    // user_grade_stats 전체 재동기 — 품계는 상대 백분위라 전 사용자 재계산이 필요하다.
    // syncAllGradeStats(사용자별 getClubRank = N회 풀스캔) → resyncGradeStatsBatch(1회 스캔)로 대체.
    const data = await resyncGradeStatsBatch();
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
