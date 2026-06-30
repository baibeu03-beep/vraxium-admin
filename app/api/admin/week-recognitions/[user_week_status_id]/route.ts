// PATCH /api/admin/week-recognitions/[user_week_status_id]
//
// 어드민 단건 상태 수정 — user_week_statuses 단일 row 의
// status / note / is_official_rest_override 만 수정한다.
//
// 쓰기 권한(ADMIN_WRITE_ROLES) 으로 보호한다.
// user_growth_stats 재집계는 수행하지 않으며 response.recalculation_skipped=true 로 알린다.
// (사유: lib/adminWeekRecognitionsData 의 updateWeekRecognition 주석 참조.)

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  updateWeekRecognition,
  WeekRecognitionUpdateError,
} from "@/lib/adminWeekRecognitionsData";
import type { WeekRecognitionUpdateInput } from "@/lib/adminWeekRecognitionsTypes";
import { readScopeMode } from "@/lib/userScopeShared";

type Ctx = { params: Promise<{ user_week_status_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_week_status_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { success: false, error: "Request body must be an object." },
      { status: 400 },
    );
  }

  // 허용 필드만 추려서 데이터 레이어에 전달(검증은 레이어에서 수행).
  const source = body as Record<string, unknown>;
  const input: WeekRecognitionUpdateInput = {};
  if ("status" in source) {
    input.status = source.status as WeekRecognitionUpdateInput["status"];
  }
  if ("note" in source) {
    input.note = source.note as WeekRecognitionUpdateInput["note"];
  }
  if ("is_official_rest_override" in source) {
    input.is_official_rest_override =
      source.is_official_rest_override as boolean;
  }

  try {
    // ?mode=test → QA 쓰기 스코프(테스트 유저만). 미지정 = operating(실사용자만). 실사용자 write 차단.
    const mode = readScopeMode(request.nextUrl.searchParams);
    const data = await updateWeekRecognition(user_week_status_id, input, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeekRecognitionUpdateError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error(
      "[admin/week-recognitions/:user_week_status_id PATCH]",
      error,
    );
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update week recognition.",
      },
      { status: 500 },
    );
  }
}
