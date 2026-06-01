// GET /api/admin/operation-health-check
//
// 어드민 조회 전용 — 시즌/주차/성장 통계 관련 데이터 정합성 문제를 진단한다.
// 자동 수정 없음(GET only). 기존 데이터를 일절 수정하지 않는다.
// 점검 로직은 lib/adminOperationHealthCheckData 참조.

import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getOperationHealthCheck } from "@/lib/adminOperationHealthCheckData";

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const data = await getOperationHealthCheck();
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/operation-health-check GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to run operation health check.",
      },
      { status: 500 },
    );
  }
}
