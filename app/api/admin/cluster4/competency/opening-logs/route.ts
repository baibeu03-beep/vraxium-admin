import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { listCompetencyOpeningLogs } from "@/lib/adminCompetencyOpeningLogs";

// 실무 역량 라인 개설 행동 이력 로그 — read-only.
//
//   GET /api/admin/cluster4/competency/opening-logs?organization={slug}
//
// 대상 주차(개설 대상, 금요일 경계 = openable week)는 상태창 API 와 동일 SoT 헬퍼로 내부 계산해
// week_id 필터에 사용한다. org + 대상 주차 기준, 최신순. demo/일반 동일 DTO.

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    let targetWeekId: string | null = null;
    const todayIso = getCurrentActivityDateIso();
    const openableStartMs = getOpenableWeekStartMs(todayIso);
    const targetInfo =
      openableStartMs != null ? describeWeekByStartMs(openableStartMs) : null;
    if (targetInfo) {
      const { data: weekRow } = await supabaseAdmin
        .from("weeks")
        .select("id")
        .eq("iso_year", targetInfo.isoYear)
        .eq("iso_week", targetInfo.isoWeek)
        .maybeSingle();
      targetWeekId = (weekRow as { id: string } | null)?.id ?? null;
    }

    const logs = await listCompetencyOpeningLogs({
      organization: org,
      weekId: targetWeekId,
    });

    return Response.json({ success: true, data: { logs } });
  } catch (error) {
    console.error("[admin/cluster4/competency/opening-logs GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "개설 로그를 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}
