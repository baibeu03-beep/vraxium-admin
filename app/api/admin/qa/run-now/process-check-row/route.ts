// POST /api/admin/qa/run-now/process-check-row
//
// 즉시 검수(행 단위) — 보드의 한 '체크 대기' 행만 지금 검수한다. 운영·테스트 공통.
//   기존 runDueProcessCheckSweep(자동 sweep 과 동일 함수)를 그대로 태우되, scheduled_check_at(검수
//   예정 시각)과 재시도 게이트만 우회한다(즉시 실행). 대상 행의 scope_mode 로만 스코프하며 mode 는
//   "대상 사용자 집합"만 결정한다(operating→운영 사용자 / test→테스트 사용자) — 상태 전이·recipients·
//   포인트·snapshot·완료 처리 규칙은 모드와 무관하게 동일하다.
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
