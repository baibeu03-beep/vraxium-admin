// 클럽 정보 > 주차 내역 > 활동 관리 — [검수 완료].
//   POST → 이 주차 결과를 최종 확정한다(액트 체크/라인 개설 검토 후 크루 결과 반영):
//     ① 공표(weeks.result_published_at) + ② 코호트 weekly-cards snapshot 재계산
//     + ③ 검수 완료(weeks.result_reviewed_at). weekly-card-finalization 과 동일 SoT·멱등.
//   주차 전역(org 무관) — 목록/상세의 "주차 검수" V 컬럼과 동일 신호(weeks 직접 읽기).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import {
  markTeamPartsWeekReviewed,
  WeekDetailWriteError,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

type Ctx = { params: Promise<{ weekId: string }> };

export async function POST(_request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = (admin as { id?: string } | null)?.id ?? null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  try {
    const result = await markTeamPartsWeekReviewed(weekId, actorId);
    // DTO: { ok, weekId, reviewed, reviewedAt } (+ 확정 상세). success 래퍼는 프론트 호환 유지.
    return Response.json({
      success: true,
      ok: true,
      weekId: result.weekId,
      reviewed: result.reviewed,
      reviewedAt: result.reviewedAt,
      data: result,
    });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "검수 완료에 실패했습니다." },
      { status: 500 },
    );
  }
}
