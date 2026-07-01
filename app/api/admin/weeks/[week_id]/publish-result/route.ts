// PATCH /api/admin/weeks/[week_id]/publish-result
//
// 주차 결과 공표 — weeks.result_published_at 을 now() 로 세팅한다.
// 공표되면 크루 페이지의 해당 주차 카드가 "성장(집계 중)"(tallying)에서
// user_week_statuses.status 기준 success(성장 성공)/fail(성장 실패)로 전환된다.
//
// 쓰기 권한(ADMIN_WRITE_ROLES) 으로 보호한다.
//   - user_week_statuses 는 변경하지 않는다 (result_published_at 만 변경).
//   - 이미 공표된 주차는 409 로 거절(중복 공표 방지). 공표 취소는 미지원.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  publishWeekResult,
  WeekResultPublishError,
} from "@/lib/adminWeekRecognitionsData";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";

type Ctx = { params: Promise<{ week_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = (admin as { id?: string } | null)?.id ?? null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { week_id } = await params;
  // ?mode=test → scope=qa (qa_weeks_state 에만 기록, 테스트 코호트만 재계산). 기본 operating.
  const scope = resolveStateScopeFromRequest(request);

  try {
    const data = await publishWeekResult(week_id, scope, actorId);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeekResultPublishError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/weeks/:week_id/publish-result PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to publish week result.",
      },
      { status: 500 },
    );
  }
}
