// POST /api/admin/qa/run-now/user-snapshot
//
// QA 즉시 실행(C5) — 선택한 테스트 사용자들의 weekly-cards snapshot 을 즉시 재계산한다.
//   기존 POST /api/admin/cluster4/recompute-user-snapshots 가 부르는 함수
//   (recomputeWeeklyCardsSnapshotsForUsers)를 동일하게 호출하되, 입력 userIds 가
//   **전원 test_user_markers** 일 때만 실행한다(하나라도 실유저면 422 fail-closed·write 0).
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES).
// body: { mode: "dry_run" | "execute", userIds: string[] }

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { runUserSnapshotNow, QaRunNowScopeError } from "@/lib/qaRunNow";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
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

  const dryRun = body.mode !== "execute"; // 기본 dry_run(안전).
  const userIds = readStringArray(body.userIds);

  try {
    const result = await runUserSnapshotNow({
      userIds,
      dryRun,
      actor: admin.email ?? admin.userId,
    });
    return Response.json({ success: true, data: result, error: null });
  } catch (error) {
    // fail-closed 스코프 위반/빈 입력 → 명시 상태코드.
    if (error instanceof QaRunNowScopeError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[qa/run-now/user-snapshot] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500 },
    );
  }
}
