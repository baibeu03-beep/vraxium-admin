// /api/admin/cluster4/opening-logs?activity_type_id=&organization=&limit=
//
// 실무 정보 라인 개설 [섹션 0] 로그창 read 전용. 현재 활동유형 기준 개설/취소 이력(최신순).
// 어드민 메타데이터 — snapshot 무관. (write 는 라인 open/cancel 핸들러에서 best-effort 로 수행.)

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listOpeningLogs } from "@/lib/adminCluster4OpeningLogs";
import { isOrganizationSlug } from "@/lib/organizations";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const activityTypeId = params.get("activity_type_id")?.trim() || null;
  if (!activityTypeId) {
    return Response.json(
      { success: false, error: "activity_type_id is required" },
      { status: 400 },
    );
  }
  // 조직 컨텍스트 수용(info=common 이라 결과 동일 — 규약 일관성).
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;
  const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

  try {
    const logs = await listOpeningLogs({ activityTypeId, organization, limit });
    return Response.json({ success: true, data: { logs } });
  } catch (error) {
    console.error("[admin/cluster4/opening-logs GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list opening logs",
      },
      { status: 500 },
    );
  }
}
