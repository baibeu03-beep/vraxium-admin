// POST /api/admin/cluster4/recompute-official-rest-snapshots
//
// 공식 휴식(official_rest_periods) 변경은 날짜 overlap 으로 다수 사용자 카드 판정에 영향을 준다.
// cron 이 제거되어(Step 6-B) markStale 만으로는 자동 재생성되지 않으므로, 관리자가 영향 주차
// 범위의 snapshot 을 이 엔드포인트로 수동 재계산한다(Step 6-C).
//
// body:
//   start_date : "YYYY-MM-DD" (필수)
//   end_date   : "YYYY-MM-DD" (필수, start_date 이상)
//   dry_run    : boolean (기본 false) — true 면 대상 수/일부 목록만 반환(재계산 안 함)
//
// 동작:
//   1) start_date~end_date 의 user_week_statuses 사용자(distinct) 수집
//   2) dry_run=true → { dry_run:true, target_count, sample }
//   3) dry_run=false → recomputeWeeklyCardsSnapshotsForUsers(동시성 3) → 실패 user_id 포함 반환
//
// 인증: 관리자 쓰기 권한(ADMIN_WRITE_ROLES). DB schema 변경 없음. cron 재추가 없음.

import type { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

export const maxDuration = 300; // 배치성 — 넉넉한 상한.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAMPLE_LIMIT = 20;

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: { start_date?: unknown; end_date?: unknown; dry_run?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const startDate = typeof body.start_date === "string" ? body.start_date.trim() : "";
  const endDate = typeof body.end_date === "string" ? body.end_date.trim() : "";
  const dryRun = body.dry_run === true;

  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return Response.json(
      { success: false, error: "start_date, end_date 는 YYYY-MM-DD 형식이어야 합니다." },
      { status: 400 },
    );
  }
  if (startDate > endDate) {
    return Response.json(
      { success: false, error: "start_date 는 end_date 이하여야 합니다." },
      { status: 400 },
    );
  }

  // 1) 영향 대상: 해당 주차 범위에 user_week_statuses 가 있는 사용자(distinct).
  const { data, error } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .gte("week_start_date", startDate)
    .lte("week_start_date", endDate);

  if (error) {
    return Response.json(
      { success: false, error: `대상 조회 실패: ${error.message}` },
      { status: 500 },
    );
  }

  const userIds = Array.from(
    new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );

  // 2) dry_run: 재계산 없이 대상 수/일부만 반환.
  if (dryRun) {
    return Response.json({
      success: true,
      data: {
        dry_run: true,
        start_date: startDate,
        end_date: endDate,
        target_count: userIds.length,
        sample_user_ids: userIds.slice(0, SAMPLE_LIMIT),
      },
      error: null,
    });
  }

  // 3) 실제 재계산(동시성 3). 사용자별 실패는 격리(기존 snapshot 유지) + 실패 목록 반환.
  const t0 = Date.now();
  try {
    const result = await recomputeWeeklyCardsSnapshotsForUsers(userIds, {
      concurrency: 3,
    });
    console.log(
      "[recompute-official-rest-snapshots] done",
      `range=${startDate}~${endDate}`,
      `requested=${result.requested} recomputed=${result.recomputed} failed=${result.failed}`,
      `| ${Date.now() - t0}ms`,
    );
    return Response.json({
      success: true,
      data: {
        dry_run: false,
        start_date: startDate,
        end_date: endDate,
        requested: result.requested,
        recomputed: result.recomputed,
        failed: result.failed,
        failed_user_ids: result.failedUserIds,
        duration_ms: Date.now() - t0,
      },
      error: null,
    });
  } catch (e) {
    // 전체 실패해도 기존 snapshot 은 그대로 — 조회 API 는 계속 동작.
    console.error("[recompute-official-rest-snapshots] fatal", e);
    return Response.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "recompute failed",
      },
      { status: 500 },
    );
  }
}
