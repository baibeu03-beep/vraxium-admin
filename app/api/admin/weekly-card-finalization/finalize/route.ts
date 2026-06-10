// POST /api/admin/weekly-card-finalization/finalize
//
// body: { seasonId | seasonKey, weekNumber, org?, mode?: "finalize" | "recompute" }
//   - mode="finalize"(기본): 해당 주차를 확정한다 = weeks.result_published_at 세팅
//     (기존 publishWeekResult 단일 SoT) + 코호트 weekly-cards snapshot 재계산.
//     이미 확정된 주차면 멱등하게 스냅샷만 재계산(alreadyFinalized=true).
//   - mode="recompute": 확정 플래그는 변경하지 않고 코호트 스냅샷만 재계산.
//
// 공표(확정)는 "주차 전체 결과" 확정으로 사용자별/조직별이 아닌 주차 전역 이벤트다.
// org 는 반환 집계(미리보기)의 표시 범위 스코프일 뿐, 공표/재계산 대상은 주차 전체 코호트다.

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  runWeeklyCardFinalization,
  WeeklyCardFinalizationError,
} from "@/lib/adminWeeklyCardFinalizationData";
import type { FinalizationMode } from "@/lib/adminWeeklyCardFinalizationTypes";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const seasonKey =
    (typeof body.seasonId === "string" && body.seasonId.trim()) ||
    (typeof body.seasonKey === "string" && body.seasonKey.trim()) ||
    "";
  const org =
    typeof body.org === "string" && body.org.trim() ? body.org.trim() : null;
  const weekNumber = Number(body.weekNumber);
  const mode: FinalizationMode = body.mode === "recompute" ? "recompute" : "finalize";

  if (!seasonKey) {
    return Response.json(
      { success: false, error: "seasonId(seasonKey) is required." },
      { status: 400 },
    );
  }
  if (!Number.isInteger(weekNumber) || weekNumber < 1) {
    return Response.json(
      { success: false, error: "weekNumber must be a positive integer." },
      { status: 400 },
    );
  }

  try {
    const data = await runWeeklyCardFinalization({
      seasonKey,
      weekNumber,
      org,
      mode,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeeklyCardFinalizationError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    // publishWeekResult 등 하위 단계가 던지는 도메인 에러(예: 409 중복 공표).
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    console.error("[admin/weekly-card-finalization/finalize POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to finalize week.",
      },
      { status },
    );
  }
}
