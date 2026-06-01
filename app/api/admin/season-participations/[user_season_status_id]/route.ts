// PATCH /api/admin/season-participations/[user_season_status_id]
//
// 어드민 단건 상태 수정 — user_season_statuses 단일 row 의 status / note 만 수정한다.
// 허용 status: success | rest. 쓰기 권한(ADMIN_WRITE_ROLES) 으로 보호한다.
//
// 이 작업은 user_week_statuses(주차 상태)를 자동 변경하지 않는다. 응답에
// week_status_sync_skipped=true + week_status_sync_note 로 그 사실을 명시한다.
// (seasonRestValidation.requestSeasonRest 정책 경로와의 관계는
//  lib/adminSeasonParticipationsData.updateSeasonParticipation 주석 참조.)

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  updateSeasonParticipation,
  SeasonParticipationUpdateError,
} from "@/lib/adminSeasonParticipationsData";
import type { SeasonParticipationUpdateInput } from "@/lib/adminSeasonParticipationsTypes";

type Ctx = { params: Promise<{ user_season_status_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_season_status_id } = await params;

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
  const input: SeasonParticipationUpdateInput = {};
  if ("status" in source) {
    input.status = source.status as SeasonParticipationUpdateInput["status"];
  }
  if ("note" in source) {
    input.note = source.note as SeasonParticipationUpdateInput["note"];
  }

  try {
    const data = await updateSeasonParticipation(user_season_status_id, input);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof SeasonParticipationUpdateError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error(
      "[admin/season-participations/:user_season_status_id PATCH]",
      error,
    );
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update season participation.",
      },
      { status: 500 },
    );
  }
}
