// GET /api/admin/weekly-card-finalization/preview?seasonId=&weekNumber=&org=
//
// 주차 카드 집계 확정 미리보기. Supabase 최신 데이터 기준으로 해당 주차의 집계 분포
// (전체 크루/성장 도전/성공/실패/개인 휴식/공식 휴식/미확정)와 주차 상태(확정 여부·
// snapshot stale 여부)를 계산해 반환한다. 읽기 전용 — 쓰기/스냅샷 변경 없음.
//
// seasonId 는 weeks.season_key(텍스트 키, 예: "2026-spring")로 해석한다.
// 파라미터가 없으면 옵션(시즌/주차 목록)만 반환한다(드롭다운 초기화용).

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  previewWeeklyCardFinalization,
  WeeklyCardFinalizationError,
} from "@/lib/adminWeeklyCardFinalizationData";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { searchParams } = new URL(request.url);
  const seasonKey = searchParams.get("seasonId")?.trim() || null;
  const org = searchParams.get("org")?.trim() || null;
  const weekNumberRaw = searchParams.get("weekNumber")?.trim() || null;

  let weekNumber: number | null = null;
  if (weekNumberRaw != null) {
    const parsed = Number(weekNumberRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return Response.json(
        { success: false, error: "weekNumber must be a positive integer." },
        { status: 400 },
      );
    }
    weekNumber = parsed;
  }

  try {
    const data = await previewWeeklyCardFinalization({ seasonKey, weekNumber, org });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeeklyCardFinalizationError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/weekly-card-finalization/preview GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load preview.",
      },
      { status: 500 },
    );
  }
}
