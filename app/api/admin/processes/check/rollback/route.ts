// POST /api/admin/processes/check/rollback
//
// Process Check ↩ 실행 취소('실행 전' 완전 복원) — 운영/테스트 공용.
//   완료된 정규 체크를 '체크 필요'(needed)로 되돌린다: 포인트 회수 + recipients 삭제 +
//   status completed→needed(검수링크·검수시점 초기화) + 대상 유저 snapshot 재계산. 재-신청으로
//   원복 가능. needed 로 내려야 관리자가 검수링크·검수시점을 다시 입력할 수 있다. 자동 sweep 무변경.
//   강한 확인 절차는 호출부(ActionControl 확인 모달)가 담당.
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES). body: { statusId: string }

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { rollbackProcessCheckCompletion } from "@/lib/processCheckRollback";

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

  try {
    const result = await rollbackProcessCheckCompletion({ statusId, actor: admin.userId });
    return Response.json({ success: true, data: result, error: null }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[processes/check/rollback] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "rollback failed" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
