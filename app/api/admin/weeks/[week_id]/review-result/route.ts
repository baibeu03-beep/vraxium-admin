// PATCH /api/admin/weeks/[week_id]/review-result
//
// 주차 결과 검수 완료 — weeks.result_reviewed_at 을 now() 로 세팅한다.
// 검수 완료되면 고객 /weekly-ranking 카드가 '공표 중' → '검수 완료'로 전환된다.
//
// 쓰기 권한(ADMIN_WRITE_ROLES) 으로 보호한다.
//   - 공표(result_published_at) 이후에만 가능 (미공표 → 409).
//   - user_week_statuses / 개인 weekly-cards snapshot 은 변경하지 않는다 (검수 완료는
//     /weekly-ranking 집계 라벨 신호일 뿐 — 개인 카드 DTO 무영향 → 재계산 불필요).
//   - 이미 검수 완료된 주차는 409 로 거절(중복 방지). 검수 취소는 미지원.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  markWeekResultReviewed,
  WeekResultReviewError,
} from "@/lib/adminWeekRecognitionsData";

type Ctx = { params: Promise<{ week_id: string }> };

export async function PATCH(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { week_id } = await params;

  try {
    const data = await markWeekResultReviewed(week_id);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeekResultReviewError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/weeks/:week_id/review-result PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to mark week result reviewed.",
      },
      { status: 500 },
    );
  }
}
