import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { syncExperienceGrowthForCrew } from "@/lib/cluster4WeeklyGrowthData";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

// 개인 실무경험 성장 상태 동기화 (success → fail 단방향, rest/현재주 제외, 멱등).
//
// 개발자 모드 기준 정책 (body { devMode: boolean, confirm?: boolean }):
//   - 테스트 사용자(display_name ILIKE '%T%')        → 항상 즉시 반영.
//   - 실사용자 + devMode=true                         → dry-run 만 (DB 미반영, 실사용자 보호).
//   - 실사용자 + devMode=false + confirm=true         → 실제 DB 반영.
//   - 실사용자 + devMode=false + confirm 없음          → dry-run 만.
export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let devMode = false;
  let confirm = false;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      devMode?: boolean;
      confirm?: boolean;
    };
    devMode = body?.devMode === true;
    confirm = body?.confirm === true;
  } catch {
    // body 없음/파싱 실패 → 안전 기본값 (devMode=false, confirm=false → 실사용자는 dry-run)
  }

  const { legacy_user_id } = await params;
  try {
    const decision = await syncExperienceGrowthForCrew(legacy_user_id, {
      devMode,
      confirm,
    });
    if (!decision) {
      return Response.json(
        { success: false, error: "Crew not found" },
        { status: 404 },
      );
    }
    // 실제 DB 반영(write) + 주차 상태가 fail 로 전환된 경우에만 그 사용자 카드가 바뀐다 →
    // 단건 즉시 재계산(관리자 동기화 직후 반영). dry-run/무변경이면 snapshot 손대지 않음. best-effort.
    if (decision.mode === "write" && decision.result.flippedToFail > 0) {
      await refreshWeeklyCardsSnapshotSafe(decision.userId);
    }
    return Response.json({
      success: true,
      devMode,
      confirm,
      isTestUser: decision.isTestUser,
      mode: decision.mode,
      dryRun: decision.mode !== "write",
      reason: decision.reason,
      data: decision.result,
    });
  } catch (error) {
    console.error(
      "[admin/crews/:legacy_user_id/cluster4/weekly-growth/sync POST]",
      error,
    );
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to sync experience growth week statuses",
      },
      { status: 500 },
    );
  }
}
