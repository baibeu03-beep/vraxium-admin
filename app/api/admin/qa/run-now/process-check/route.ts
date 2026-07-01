// POST /api/admin/qa/run-now/process-check
//
// QA 즉시 실행(A1) — 프로세스 체크 자동검수 sweep 을 관리자 세션으로 1회 수동 실행한다.
//   내부적으로 기존 runDueProcessCheckSweep(scope='qa') 를 호출 → scope_mode='test' 항목만
//   강제 처리(운영 항목 절대 무접촉). 기존 자동 스케줄러(GitHub Actions)·내부키 라우트는 무변경.
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES) — 사람이 누르는 버튼이므로 내부키가 아니라 세션.
// body: { mode: "dry_run" | "execute", onlyIds?: string[] }
//   dry_run = 테스트 due 항목만 식별(무변경). execute = 실제 검수/적립(테스트 한정·멱등).

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { runProcessCheckNow } from "@/lib/qaRunNow";

export const maxDuration = 300; // 크롤 직렬 처리 — 넉넉한 상한(초과분 capped → 다음 실행 catch-up).
export const dynamic = "force-dynamic";

function readStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  return out.length ? out : null;
}

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

  const dryRun = body.mode !== "execute"; // 기본 dry_run(안전) — execute 를 명시해야 실제 실행.
  const onlyIds = readStringArray(body.onlyIds);

  try {
    const result = await runProcessCheckNow({
      dryRun,
      onlyIds,
      actor: admin.email ?? admin.userId,
    });
    return Response.json({ success: true, data: result, error: null });
  } catch (error) {
    console.error("[qa/run-now/process-check] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500 },
    );
  }
}
