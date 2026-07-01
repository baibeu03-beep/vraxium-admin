// POST /api/admin/qa/run-now/process-check-row
//
// QA 즉시 실행(A1·행 단위) — 보드의 한 '체크 대기' 행만 지금 자동 검수한다.
//   기존 runDueProcessCheckSweep 의 처리 로직을 그대로 태우되, scheduled_check_at(검수 예정 시각)과
//   재시도 게이트만 우회한다(즉시 실행). 테스트 항목(scope_mode='test')만 허용(fail-closed).
//   자동 스케줄(GitHub Actions)은 무변경 — 본 라우트만 시각 조건을 우회한다.
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES). body: { statusId: string }

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { runProcessCheckRowNow, QaRunNowScopeError } from "@/lib/qaRunNow";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const statusId = typeof body.statusId === "string" ? body.statusId.trim() : "";
  const source = body.source === "irregular" ? "irregular" : "regular";

  try {
    const result = await runProcessCheckRowNow({
      statusId,
      source,
      actor: admin.userId,
    });
    return Response.json({ success: true, data: result, error: null }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof QaRunNowScopeError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }
    console.error("[qa/run-now/process-check-row] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
