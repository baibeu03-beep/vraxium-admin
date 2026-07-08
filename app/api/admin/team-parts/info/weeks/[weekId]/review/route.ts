// 클럽 정보 > 주차 내역 > 활동 관리 — [검수 완료].
//   POST → 이 주차 결과를 최종 확정한다(액트 체크/라인 개설 검토 후 크루 결과 반영):
//     ① 공표(weeks.result_published_at) + ② 코호트 weekly-cards snapshot 재계산
//     + ③ 검수 완료(weeks.result_reviewed_at). weekly-card-finalization 과 동일 SoT·멱등.
//   주차 전역(org 무관) — 목록/상세의 "주차 검수" V 컬럼과 동일 신호(weeks 직접 읽기).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import {
  markTeamPartsWeekReviewed,
  revertTeamPartsWeekReview,
  WeekDetailWriteError,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";

type Ctx = { params: Promise<{ weekId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = (admin as { id?: string } | null)?.id ?? null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  // scope: ?mode=test → qa(테스트 코호트·qa_weeks_state). 기본 operating(실유저·운영 weeks).
  const scope = resolveStateScopeFromRequest(request);
  // allowIncompleteTestData: 안전장치(라인0 mass-fail·적립 미완료·pending) bypass 요청.
  //   ⚠ 실제 bypass 여부는 서버가 scope 로 최종 판정(operating 실유저면 무시). body 없으면 false.
  let allowIncompleteTestData = false;
  try {
    const body = (await request.json()) as { allowIncompleteTestData?: unknown } | null;
    allowIncompleteTestData = body?.allowIncompleteTestData === true;
  } catch {
    // body 없음(기존 호출 호환) → false.
  }

  try {
    const result = await markTeamPartsWeekReviewed(weekId, actorId, {
      scope,
      allowIncompleteTestData,
    });
    // DTO: { ok, weekId, reviewed, reviewedAt } (+ 확정 상세). success 래퍼는 프론트 호환 유지.
    return Response.json({
      success: true,
      ok: true,
      weekId: result.weekId,
      reviewed: result.reviewed,
      reviewedAt: result.reviewedAt,
      data: result,
    });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "검수 완료에 실패했습니다." },
      { status: 500 },
    );
  }
}

// DELETE — ↩ 실행 취소: 주차 검수(공표+검수) 실행 직전 상태로 복원.
//   result_published_at=NULL + result_reviewed_at=NULL + 코호트 재계산 → 카드 success/fail→tallying.
//   ?mode=test → scope=qa(qa_weeks_state·테스트 코호트·안전). 기본 operating. 강한 확인 모달은 UI 책임.
export async function DELETE(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = (admin as { id?: string } | null)?.id ?? null;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }
  const scope = resolveStateScopeFromRequest(request);

  try {
    const result = await revertTeamPartsWeekReview(weekId, scope, actorId);
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "주차 검수 실행 취소에 실패했습니다." },
      { status: 500 },
    );
  }
}
