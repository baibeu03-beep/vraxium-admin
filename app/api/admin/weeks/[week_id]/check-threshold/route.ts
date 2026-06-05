// PATCH /api/admin/weeks/[week_id]/check-threshold
//
// 주차 인정 point.check 기준값 수정 — weeks.check_threshold 를 갱신한다.
//   body: { check_threshold: number | null }  (null = 기본값 30 사용)
//
// 이 값은 레거시(허브 도입 전, 2026 여름 W1 이전) 통합 라인 주차의 "주차 성공"
// read-time 판정(평점 ≥4 = 강화 성공 AND check >= 기준값)에 사용된다.
//   - user_week_statuses(주차 상태 SoT)는 변경하지 않는다.
//   - advantage / penalty 는 판정에 사용하지 않는다.
//   - 변경 직후 해당 주차 참여자 snapshot 재계산(best-effort) — publish-result 와 동일 패턴.
//
// 쓰기 권한(ADMIN_WRITE_ROLES)으로 보호한다.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  updateWeekCheckThreshold,
  WeekCheckThresholdUpdateError,
} from "@/lib/adminWeekRecognitionsData";

type Ctx = { params: Promise<{ week_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { week_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null) {
    return Response.json(
      { success: false, error: "Body must be an object." },
      { status: 400 },
    );
  }
  if (!("check_threshold" in body)) {
    return Response.json(
      { success: false, error: "check_threshold is required (number or null)." },
      { status: 400 },
    );
  }

  try {
    const data = await updateWeekCheckThreshold(week_id, {
      check_threshold: (body as { check_threshold: number | null })
        .check_threshold,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeekCheckThresholdUpdateError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/weeks/:week_id/check-threshold PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update check threshold.",
      },
      { status: 500 },
    );
  }
}
