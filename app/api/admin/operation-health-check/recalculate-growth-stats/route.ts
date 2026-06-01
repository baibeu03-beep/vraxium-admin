// POST /api/admin/operation-health-check/recalculate-growth-stats
//
// 성장 통계 불일치(growth_approved_mismatch/growth_cumulative_mismatch)만 수동 복구한다.
// 수정 대상은 user_growth_stats 뿐 — user_week_statuses / user_season_statuses /
// weeks / season_definitions 는 절대 수정하지 않는다(읽기만).
//
// 쓰기 권한(ADMIN_WRITE_ROLES) 으로 보호한다.
//
// mode:
//   - "single"         : body.user_id 1명만 recalcUserGrowthStats 호출
//   - "all_mismatched" : 정합성 점검과 동일 기준의 불일치 user_id 전체(최대 100명) 재집계

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { getGrowthStatsMismatchedUserIds } from "@/lib/adminOperationHealthCheckData";
import type {
  RecalcGrowthStatsMode,
  RecalcGrowthStatsResult,
  RecalcGrowthStatsResultItem,
} from "@/lib/adminOperationHealthCheckTypes";

// all_mismatched 한 번에 처리할 사용자 상한.
const MAX_RECALC = 100;

function isMode(value: unknown): value is RecalcGrowthStatsMode {
  return value === "single" || value === "all_mismatched";
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { success: false, error: "Request body must be an object." },
      { status: 400 },
    );
  }

  const source = body as Record<string, unknown>;
  const mode = source.mode;
  if (!isMode(mode)) {
    return Response.json(
      { success: false, error: 'mode must be "single" or "all_mismatched".' },
      { status: 400 },
    );
  }

  // 처리 대상 user_id 목록을 모드별로 확정한다.
  let targetIds: string[];
  let skippedCount = 0;

  if (mode === "single") {
    const userId = String(source.user_id ?? "").trim();
    if (!userId) {
      return Response.json(
        { success: false, error: "user_id is required for single mode." },
        { status: 400 },
      );
    }
    targetIds = [userId];
  } else {
    let mismatchedIds: string[];
    try {
      mismatchedIds = await getGrowthStatsMismatchedUserIds();
    } catch (error) {
      console.error(
        "[admin/operation-health-check/recalculate-growth-stats] mismatch scan failed",
        error,
      );
      return Response.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to scan growth-stats mismatches.",
        },
        { status: 500 },
      );
    }

    if (mismatchedIds.length > MAX_RECALC) {
      targetIds = mismatchedIds.slice(0, MAX_RECALC);
      skippedCount = mismatchedIds.length - MAX_RECALC;
    } else {
      targetIds = mismatchedIds;
    }
  }

  // 대상별로 순차 재집계. 개별 실패는 results 에 담고 전체는 계속 진행한다.
  const results: RecalcGrowthStatsResultItem[] = [];
  let processedCount = 0;
  let failedCount = 0;

  for (const userId of targetIds) {
    try {
      const stats = await recalcUserGrowthStats(userId);
      results.push({
        user_id: userId,
        status: "success",
        approved_weeks: stats.approved_weeks,
        cumulative_weeks: stats.cumulative_weeks,
      });
      processedCount += 1;
    } catch (error) {
      results.push({
        user_id: userId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      failedCount += 1;
    }
  }

  const data: RecalcGrowthStatsResult = {
    mode,
    processed_count: processedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    truncated: skippedCount > 0,
    results,
  };

  return Response.json({ success: true, data });
}
