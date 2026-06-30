import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScope";

// GET /api/admin/cluster4/info-line-results?week_id=
// 선택 주차의 "주차별 개설 결과" — 활동유형별 개설 상황(opened/needs_opening/not_open) + 카운트.
// 순수 read — snapshot/demoUserId/고객 DTO 무관.
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
  if (!weekId || !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id is required and must be a UUID" },
      { status: 400 },
    );
  }
  // 조직 스코프(통합 ↔ 조직 진입). 내부 API 컨벤션은 organization. 미지정/무효 = 통합(전체).
  // info-lines GET 과 동일 컨벤션 — 지정 시 (lineOrg == org) OR common 만 노출.
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;
  // 운영/테스트 모집단 스코프(QA 누수 차단) — ?mode=test → user 대상자가 marker 인 라인만(운영 라인 0건).
  const mode = readScopeMode(params);

  try {
    const data = await getInfoLineResultsForWeek({ weekId, organization, mode });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/info-line-results GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load info line results",
      },
      { status: 500 },
    );
  }
}
