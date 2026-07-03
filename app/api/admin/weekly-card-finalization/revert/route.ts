// POST /api/admin/weekly-card-finalization/revert
//
// ↩ 실행 취소 — 집계 확정(주차 검수) 실행 직전 상태로 복원.
//   body: { seasonId | seasonKey, weekNumber, org? }
//   result_published_at = NULL(미공표) + result_reviewed_at = NULL(검수⇒공표 불변식 유지)
//   + 코호트 weekly-cards snapshot 재계산 → 고객 카드 success/fail → tallying(집계 중) 복귀.
//   ?mode=test → scope=qa(qa_weeks_state 오버레이 null·테스트 코호트만·실유저 무접촉). 기본 operating.
//   ⚠ 전 크루·고객 앱 영향을 주는 최종 역연산 — 강한 확인 모달을 거친 요청만 도달해야 한다(UI 책임).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  revertWeeklyCardFinalization,
  WeeklyCardFinalizationError,
} from "@/lib/adminWeeklyCardFinalizationData";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = (admin as { id?: string } | null)?.id ?? null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const scope = resolveStateScopeFromRequest(request);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const seasonKey =
    (typeof body.seasonId === "string" && body.seasonId.trim()) ||
    (typeof body.seasonKey === "string" && body.seasonKey.trim()) ||
    "";
  const org = typeof body.org === "string" && body.org.trim() ? body.org.trim() : null;
  const weekNumber = Number(body.weekNumber);

  if (!seasonKey) {
    return Response.json({ success: false, error: "seasonId(seasonKey) is required." }, { status: 400 });
  }
  if (!Number.isInteger(weekNumber) || weekNumber < 1) {
    return Response.json({ success: false, error: "weekNumber must be a positive integer." }, { status: 400 });
  }

  try {
    const data = await revertWeeklyCardFinalization({ seasonKey, weekNumber, org, scope, actor: actorId });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof WeeklyCardFinalizationError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    console.error("[admin/weekly-card-finalization/revert POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to revert finalization." },
      { status },
    );
  }
}
