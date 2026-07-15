import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import {
  resolveCrewWeekContext,
  getCrewWeekActDetail,
} from "@/lib/adminCrewWeekActDetail";
import { softCancelActAwards } from "@/lib/processPointAccrual";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// 한 번에 취소 가능한 최대 액트 수(과대 일괄 방어).
const MAX_CANCEL_BATCH = 200;

// POST /api/admin/members/[user_id]/weeks/[week_id]/acts/cancel
//   지정한 크루의 특정 액트(원장 행) 소프트 취소. body: { awardIds: string[], reason?: string }.
//   - 서버 검증: 관리자 인증/권한 + 스코프(422) + weekId 소유(404) + isCrewWeekEditable(403) +
//     각 awardId 가 그 크루 소유인지(422) + 존재(404). URL/ body ID 를 그대로 신뢰하지 않는다.
//   - 취소는 개별 원장 행(id, user_id) 단위 — (source,ref_id) 코호트 취소 아님.
//   - 취소 후 공통 재집계(취소 행 제외 합산: 최종 B 복원·C 감소) + snapshot 재생성으로 전 표면 수렴.
//   - 멱등: 이미 취소된 행은 건너뛰어 중복 차감 없음(cancelledCount 로 실제 반영 건수 반환).
export async function POST(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ success: false, error: "Request body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const rawIds = Array.isArray(b.awardIds) ? b.awardIds : null;
  if (!rawIds) {
    return Response.json({ success: false, error: "awardIds must be an array" }, { status: 400 });
  }
  const awardIds = Array.from(
    new Set(rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)),
  );
  if (awardIds.length === 0) {
    return Response.json({ success: false, error: "취소할 액트를 선택해 주세요." }, { status: 400 });
  }
  if (awardIds.length > MAX_CANCEL_BATCH) {
    return Response.json(
      { success: false, error: `한 번에 최대 ${MAX_CANCEL_BATCH}건까지 취소할 수 있습니다.` },
      { status: 400 },
    );
  }
  const reason =
    typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;

  try {
    await assertUserInRequestScope(request, user_id, { bodyMode: b.mode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  // 크루+주차 컨텍스트 — 소유(카드 실재) 검증 + 재집계용 realWeekId + 수정 가능 판정.
  const resolved = await resolveCrewWeekContext(user_id, week_id);
  if (!resolved.ok) {
    const message =
      resolved.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
    return Response.json({ success: false, error: message }, { status: 404 });
  }
  const { ctx } = resolved;

  // 성장 결과 진행 중/집계 중 잠금(프론트 비활성과 동일 SoT). 직접 호출도 여기서 403.
  if (!ctx.editable) {
    return Response.json(
      {
        success: false,
        code: "CREW_WEEK_NOT_EDITABLE",
        error: "진행 중이거나 집계 중인 주차의 액트는 수정할 수 없습니다.",
      },
      { status: 403 },
    );
  }

  // 재집계는 (iso_year,iso_week) 축 — 카드 startDate 로 되짚은 실제 weeks.id 가 필요하다.
  if (!ctx.realWeekId) {
    return Response.json(
      { success: false, error: "주차 매핑을 해석할 수 없어 취소를 진행할 수 없습니다." },
      { status: 409 },
    );
  }

  try {
    const { cancelledCount } = await softCancelActAwards({
      awardIds,
      userId: ctx.userId,
      weekId: ctx.realWeekId,
      cancelledBy: admin.userId,
      reason,
    });

    // 최신 DTO 재조회(취소 반영) — 프론트가 optimistic 없이 전체 교체.
    const refreshed = await getCrewWeekActDetail(user_id, week_id);
    const weekDetail = refreshed.ok ? refreshed.data : null;

    return Response.json({ success: true, data: { cancelledCount, weekDetail } });
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status) {
      return Response.json(
        {
          success: false,
          ...(code ? { code } : {}),
          error: error instanceof Error ? error.message : "액트 취소에 실패했습니다.",
        },
        { status },
      );
    }
    console.error("[admin/members/:user_id/weeks/:week_id/acts/cancel POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "액트 취소에 실패했습니다." },
      { status: 500 },
    );
  }
}
