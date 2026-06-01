// POST /api/admin/cluster4/recompute-user-snapshots
//
// 고객앱(vraxium) 등 내부 서비스가 "저장 직후" 특정 사용자들의 주차 카드 snapshot 을
// 즉시 재계산하도록 트리거하는 server-to-server 엔드포인트.
//   - line submission / weekly-reputations / weekly-colleagues 등 카드에 영향을 주는
//     고객 쓰기 후, 그 사용자 id 로 호출하면 admin snapshot 이 갱신된다(cron 불필요).
//   - 조회 API 는 절대 재계산하지 않는다 — 재계산은 쓰기 시점/이 엔드포인트에서만.
//
// 인증: x-internal-api-key == process.env.INTERNAL_API_KEY (없거나 틀리면 401).
// body: { "userIds": ["uuid", ...] }  (중복 제거, 최대 100명)
// 응답: { requested, recomputed, failed, failed_user_ids }
//
// DB schema 변경 없음. 사용자별 실패는 격리(기존 snapshot 유지) + 실패 목록 반환.

import type { NextRequest } from "next/server";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

export const maxDuration = 300; // 배치성 — 넉넉한 상한.
export const dynamic = "force-dynamic";

const MAX_USERS = 100;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  // ── 인증: 내부 API 키 ──
  const expected = process.env.INTERNAL_API_KEY;
  const provided = request.headers.get("x-internal-api-key");
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // ── body 파싱/검증 ──
  let body: { userIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.userIds)) {
    return Response.json(
      { success: false, error: "userIds must be an array." },
      { status: 400 },
    );
  }

  // 문자열만, 공백 제거, 중복 제거.
  const userIds = Array.from(
    new Set(
      body.userIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );

  if (userIds.length === 0) {
    return Response.json(
      { success: false, error: "userIds is empty." },
      { status: 400 },
    );
  }
  if (userIds.length > MAX_USERS) {
    return Response.json(
      { success: false, error: `Too many userIds (max ${MAX_USERS}).` },
      { status: 400 },
    );
  }

  // ── 재계산 (동시성 3). 사용자별 실패는 격리 → 실패 목록 포함 반환. ──
  const t0 = Date.now();
  try {
    const result = await recomputeWeeklyCardsSnapshotsForUsers(userIds, {
      concurrency: 3,
    });
    console.log(
      "[recompute-user-snapshots] done",
      `requested=${result.requested} recomputed=${result.recomputed} failed=${result.failed}`,
      `| ${Date.now() - t0}ms`,
    );
    return Response.json({
      success: true,
      data: {
        requested: result.requested,
        recomputed: result.recomputed,
        failed: result.failed,
        failed_user_ids: result.failedUserIds,
      },
      error: null,
    });
  } catch (e) {
    // 전체 실패해도 기존 snapshot 은 그대로 — 조회 API 는 계속 동작.
    console.error("[recompute-user-snapshots] fatal", e);
    return Response.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "recompute failed",
      },
      { status: 500 },
    );
  }
}
