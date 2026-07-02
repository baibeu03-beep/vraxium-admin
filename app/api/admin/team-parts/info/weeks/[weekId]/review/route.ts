// 클럽 정보 > 주차 내역 > 활동 관리 — [주차 검수].
//   POST  → weeks.result_reviewed_at 세팅(publish 개념·전 서비스 반영 가능 상태 확정).
//   새 데이터 계산/ snapshot 재계산 없음. 주차 전역(org 무관) — 주차 내역 표 "주차 검수" 컬럼과 동일 신호.

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
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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
    const result = await markTeamPartsWeekReviewed(weekId);
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "주차 검수에 실패했습니다." },
      { status: 500 },
    );
  }
}
