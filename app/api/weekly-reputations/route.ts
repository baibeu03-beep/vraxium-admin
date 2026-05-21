// GET /api/weekly-reputations?target_user_id=<uuid>&week_card_id=<uuid>
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 본 admin repo 에서는 requireAdmin(ADMIN_READ_ROLES) 로 게이트한다. Front repo
// 에 동일 경로가 복제될 때는 인증 모델을 swap:
//
//   - 세션 사용자 = ?target_user_id → 통과 (self read)
//   - 세션 사용자 ≠ ?target_user_id → admin 일 때만 통과 (cross-user read)
//
// 본 단계는 read 전용. raw peer-review row 만 반환 — aggregation/derived 값 미포함.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listWeeklyReputations } from "@/lib/weeklyReputationsData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const targetUserId = (sp.get("target_user_id") ?? "").trim();
  if (!targetUserId) {
    return Response.json(
      { success: false, error: "target_user_id is required." },
      { status: 400 },
    );
  }

  const weekCardIdParam = (sp.get("week_card_id") ?? "").trim();

  try {
    const result = await listWeeklyReputations({
      targetUserId,
      weekCardId: weekCardIdParam || undefined,
    });
    return Response.json({
      success: true,
      data: {
        target_user_id: targetUserId,
        reputations: result.rows,
      },
      meta: { available: result.available, count: result.rows.length },
    });
  } catch (error) {
    console.error("[weekly-reputations GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load weekly_reputations.",
      },
      { status: 500 },
    );
  }
}
