// GET /api/admin/qa/run-now/logs
//
// QA 즉시 실행 감사 로그 조회(표시 전용). qa_run_now_log 최근 N건.
//   테이블 미적용 시 빈 배열(화면 안 깨짐). 조회 전용 — 어떤 자동 로직도 트리거하지 않는다.
//
// 인증: 관리자 읽기 권한(ADMIN_READ_ROLES). query: ?limit=20 (1~100)

import type { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { listQaRunNowLogs } from "@/lib/qaRunNow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const limit = Number(request.nextUrl.searchParams.get("limit")) || 20;
  try {
    const data = await listQaRunNowLogs(limit);
    return Response.json({ success: true, data, error: null });
  } catch (error) {
    console.error("[qa/run-now/logs] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "load failed" },
      { status: 500 },
    );
  }
}
