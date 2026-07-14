// GET /api/admin/cluster4/info-line-open-status?week_id=&organization=[&mode=]
//
// 실무 정보 활동유형(9종) 각각이 선택 주차에 "오픈(개설 대상)"인지 일괄 반환한다(라인 개설 탭의
//   활동유형 탭 미오픈 배지/어둠 처리용). 판정 = weekOpenGate.isInfoLineOpenForWeek 단일 SoT
//   (open_confirmed + practicalInfo[activityType] 체크) — 실제 개설 저장/개설 폼과 동일 함수·동일 기준.
//   ⚠ mode(operating/test)·org 로 판정을 분기하지 않는다. mode 는 파라미터로 받되 판정에 영향 없음(무분기).
//     통합(organization 미지정)은 단일 클럽 config 가 없으므로 전부 오픈으로 본다(게이트 미적용).

import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { isUuid } from "@/lib/isUuid";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isInfoLineOpenForWeek } from "@/lib/weekOpenGate";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const weekId = params.get("week_id")?.trim() || null;
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;

  if (!weekId || !isUuid(weekId)) {
    return Response.json({ success: false, error: "week_id must be a UUID" }, { status: 400 });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("activity_types")
      .select("id")
      .eq("cluster_id", "practical_info")
      .eq("is_active", true);
    if (error) return Response.json({ success: false, error: error.message }, { status: 500 });
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);

    // org 지정 시에만 게이트 적용 — loadWeekOpeningConfig 는 1회 조회, 판정은 isInfoLineOpenForWeek 공용.
    const openByActivityType: Record<string, boolean> = {};
    if (organization) {
      const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, organization);
      for (const id of ids) {
        openByActivityType[id] = isInfoLineOpenForWeek({ openConfirmed, config, activityTypeId: id });
      }
    } else {
      for (const id of ids) openByActivityType[id] = true; // 통합 = 게이트 미적용.
    }

    return Response.json({ success: true, data: { weekId, openByActivityType } });
  } catch (error) {
    console.error("[admin/cluster4/info-line-open-status GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
