// POST /api/admin/processes/check/recollect
//
//   "댓글 다시 수집" — 자동 검수 수집이 일시 오류로 끝난 한 행을 운영자가 지금 다시 수집한다.
//   기존 sweep 로직(lib/processCheckDueSweep)을 그 행에만(onlyIds) 태우되 검수 예정 시각·재시도 게이트만
//   우회한다. 자동 스케줄(GitHub Actions)·QA 즉시 실행과는 별개 — 운영/테스트 모든 행에 쓸 수 있다.
//
//   ⚠ 안전장치(요구사항):
//     · 멱등 — 원장(process_point_awards) UNIQUE 로 중복 적립 없음. 완료 행은 재폴링 제외 → 중복 완료 없음.
//     · 재수집 실패 시 sweep 은 raw_comment_count·recipients·checked_crew_count 를 건드리지 않는다
//       (이전 정상 수집 결과를 0 으로 덮어쓰지 않음). 상태만 'error' 로 각인.
//     · 성공 시에만 최신 결과로 갱신(recipients 재삽입 + raw_comment_count + status='completed').
//   ⚠ scope='qa'(force-complete)를 쓰지 않는다 — 크롤 성공 시에만 완료한다(오류를 완료로 위장하지 않음).
//
//   인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES) — 사람 버튼(내부 키 배치 트리거 아님).
//   body: { organization, statusId, source?: 'regular'|'irregular' }

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { parseScopeMode } from "@/lib/userScopeShared";

export const maxDuration = 300; // 크롤링(외부 서비스) 왕복 — 넉넉한 상한.
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const orgRaw = typeof body.organization === "string" ? body.organization.trim() : "";
  const statusId = typeof body.statusId === "string" ? body.statusId.trim() : "";
  const source = body.source === "irregular" ? "irregular" : "regular";
  const table = source === "irregular" ? "process_irregular_acts" : "process_check_statuses";

  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "소속 클럽을 다시 선택해주세요." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (!statusId || !UUID_RE.test(statusId)) {
    return Response.json(
      { success: false, error: "statusId 형식이 올바르지 않습니다" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // 대상 행 로드 — org 일치(방어) + scope_mode 확인(운영/테스트 어느 쪽이든 그 행만 처리).
  const { data: row, error: rowErr } = await supabaseAdmin
    .from(table)
    .select("id,organization_slug,scope_mode,status")
    .eq("id", statusId)
    .maybeSingle();
  if (rowErr) {
    console.error("[processes/check/recollect] row read", rowErr);
    return Response.json(
      { success: false, error: "대상 행을 조회하지 못했습니다" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
  if (!row) {
    return Response.json(
      { success: false, error: "대상 행을 찾을 수 없습니다" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  const r = row as { organization_slug: string; scope_mode: string | null; status: string };
  if (r.organization_slug !== orgRaw) {
    return Response.json(
      { success: false, error: "organization 이 대상 행과 일치하지 않습니다" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  const mode = parseScopeMode(r.scope_mode);

  try {
    // 그 행만(onlyIds) 즉시 재수집 — 검수 예정 시각·재시도 게이트 우회. 그 행의 실제 scope_mode 만 처리(fail-safe).
    const result = await runDueProcessCheckSweep({
      orgs: [orgRaw],
      modes: [mode],
      onlyIds: [statusId],
      ignoreSchedule: true,
      ignoreRetryGate: true,
      actor: admin.userId,
      log: (m) => console.log(`[recollect] ${m}`),
    });
    const item = result.items.find((it) => it.id === statusId);

    // 완료 행이라 findDue(pending)에서 제외되었거나(이미 완료) 스코프 밖이면 no-op(멱등·안전).
    if (!item) {
      return Response.json(
        {
          success: true,
          data: { outcome: "noop", note: r.status === "completed" ? "이미 완료된 항목입니다" : "재수집 대상이 아닙니다" },
        },
        { headers: NO_STORE_HEADERS },
      );
    }
    if (item.outcome === "completed") {
      return Response.json(
        {
          success: true,
          data: {
            outcome: "completed",
            matched: item.matched,
            review: item.review,
            rawCommentCount: item.rawCommentCount,
          },
        },
        { headers: NO_STORE_HEADERS },
      );
    }
    // 실패 — 기존 결과는 보존됨(0 덮어쓰기 없음). 사용자 문구는 클라(일시 오류)에서 매핑.
    return Response.json(
      { success: false, error: "댓글 정보를 일시적으로 가져오지 못했습니다. 다시 수집해주세요.", errorCode: item.errorCode },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[processes/check/recollect] sweep error", error);
    return Response.json(
      { success: false, error: "댓글 정보를 일시적으로 가져오지 못했습니다. 다시 수집해주세요." },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
