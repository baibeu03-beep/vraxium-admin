// POST /api/admin/qa/run-now/snapshot-batch
//
// QA 즉시 실행(B2) — weekly-cards snapshot 배치 재계산을 관리자 세션으로 1회 수동 실행한다.
//   대상 = test_user_markers 전수(테스트 사용자 한정). 운영 전원 재계산은 하지 않는다.
//   기존 GET /api/admin/cluster4/recompute-snapshots 와 동일한 재계산 함수
//   (recomputeWeeklyCardsSnapshotsForUsers)를 테스트 스코프로 호출 — 자동 lazy/내부키 라우트 무변경.
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES).
// body: { mode: "dry_run" | "execute" }
//   dry_run = 테스트 유저 snapshot 신선도만 집계(무변경). execute = 테스트 유저 전수 재계산.

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { runSnapshotBatchNow } from "@/lib/qaRunNow";

export const maxDuration = 300; // 배치성 — 넉넉한 상한.
export const dynamic = "force-dynamic";

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

  const dryRun = body.mode !== "execute"; // 기본 dry_run(안전).

  try {
    const result = await runSnapshotBatchNow({
      dryRun,
      actor: admin.email ?? admin.userId,
    });
    return Response.json({ success: true, data: result, error: null });
  } catch (error) {
    console.error("[qa/run-now/snapshot-batch] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500 },
    );
  }
}
