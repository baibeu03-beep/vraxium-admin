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
import { listExperienceOpeningLogs } from "@/lib/adminExperienceOpeningLogs";

// 실무 경험 라인 개설 행동 이력 로그 — read-only.
//
//   GET /api/admin/cluster4/experience/opening-logs?organization={slug}
//
// 대상 주차(targetWeek = 개설 대상, 금요일 경계 = isOpenTarget)는 상태창 API 와 동일 SoT 헬퍼로
// 내부 계산해 week_id 필터에 사용한다. org + 대상 주차 기준, 최신순.
// demo/일반 동일 DTO(org 스코프, userId 파라미터 없음).

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;
  // 파트장 입력 그리드가 실제로 작업 중인 주차(?week_id) — 개설 대상(금요일 경계) 밖의
  //   예외 주차(line_opening_windows scope=all)로 라인을 열면 로그도 그 주차에 남는다. 그리드와
  //   같은 주차의 로그를 보여주기 위해 override 를 우선한다. 미지정(기존 호출)이면 개설 대상 주차 폴백.
  const overrideWeekId =
    request.nextUrl.searchParams.get("week_id")?.trim() || null;

  try {
    // 대상 주차 weeks.id(UUID) — override 우선, 없으면 개설 대상(금요일 경계) 주차.
    let targetWeekId: string | null = overrideWeekId;
    if (!targetWeekId) {
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
    }

    const logs = await listExperienceOpeningLogs({
      organization: org,
      weekId: targetWeekId,
    });

    return Response.json({ success: true, data: { logs } });
  } catch (error) {
    console.error("[admin/cluster4/experience/opening-logs GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "개설 로그를 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}
