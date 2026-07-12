// POST /api/admin/processes/check/irregular/rollback
//
// 변동(비정규) 액트 ↩ 실행 취소(직전 "실행 전" 상태 복원) — 운영/테스트 공용.
//   링크 신청 → 체크 대기(검수 전·행 유지·재검수 가능) · 수동 부여 → 행 삭제(부여 전=부재).
//   공통: 적립 포인트 회수 + recipients 삭제 + 대상 유저 snapshot 재계산. org/mode 무관 동일 로직.
//   강한 확인 절차는 호출부(ActionControl 확인 모달)가 담당.
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES). body: { id, organization, mode? }

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import { rollbackIrregularAct } from "@/lib/adminProcessIrregularData";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errStatus(error: unknown): number {
  return error instanceof ProcessMasterError
    ? error.status
    : typeof (error as { status?: unknown })?.status === "number"
      ? ((error as { status: number }).status)
      : 500;
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const orgRaw = typeof body.organization === "string" ? body.organization.trim() : "";
  const mode = parseScopeMode(typeof body.mode === "string" ? body.mode : null);
  if (!id || !UUID_RE.test(id)) {
    return Response.json(
      { success: false, error: "id 형식이 올바르지 않습니다" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "organization 은 유효한 클럽이어야 합니다" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const data = await rollbackIrregularAct(id, orgRaw, mode);
    return Response.json({ success: true, data, error: null }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[processes/check/irregular/rollback] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "rollback failed" },
      { status: errStatus(error), headers: NO_STORE_HEADERS },
    );
  }
}
