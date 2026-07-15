import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import {
  resolveCrewWeekContext,
  getCrewWeekActDetail,
} from "@/lib/adminCrewWeekActDetail";
import { createActSupplement } from "@/lib/adminProcessIrregularData";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

const ACT_NAME_MAX = 20;
const REASON_MAX = 50;

function intInRange(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  return n;
}

// POST /api/admin/members/[user_id]/weeks/[week_id]/acts/supplement
//   특정 크루·특정 주차에 변동·부분·즉시 체크 완료 액트 1건을 생성(액트 보완). 기존 수동 부여 SoT
//   (createActSupplement → accrueForCompletedIrregular)를 재사용해 포인트 원장·재집계·snapshot 까지 반영.
//   body: { actName, reason?, pointA, pointB, pointC }.
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

  // 입력 검증(서버 강제 — 프론트와 동일 규칙).
  const actName = typeof b.actName === "string" ? b.actName.trim() : "";
  if (!actName) return Response.json({ success: false, error: "액트명은 필수입니다." }, { status: 400 });
  if (actName.length > ACT_NAME_MAX) {
    return Response.json({ success: false, error: `액트명은 최대 ${ACT_NAME_MAX}자입니다.` }, { status: 400 });
  }
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length > REASON_MAX) {
    return Response.json({ success: false, error: `사유는 최대 ${REASON_MAX}자입니다.` }, { status: 400 });
  }
  const pointA = intInRange(b.pointA ?? 0);
  const pointB = intInRange(b.pointB ?? 0);
  const pointC = intInRange(b.pointC ?? 0);
  if (pointA === null || pointB === null || pointC === null) {
    return Response.json({ success: false, error: "포인트는 0~20 정수여야 합니다." }, { status: 400 });
  }
  if (pointA === 0 && pointB === 0 && pointC === 0) {
    return Response.json({ success: false, error: "포인트를 1점 이상 부여해야 합니다." }, { status: 400 });
  }
  if ((pointA > 0 || pointB > 0) && pointC > 0) {
    return Response.json(
      { success: false, error: "부분 액트는 포인트 A·B 또는 포인트 C 중 한쪽만 부여할 수 있습니다." },
      { status: 422 },
    );
  }

  try {
    await assertUserInRequestScope(request, user_id, { bodyMode: b.mode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  const resolved = await resolveCrewWeekContext(user_id, week_id);
  if (!resolved.ok) {
    const message =
      resolved.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
    return Response.json({ success: false, error: message }, { status: 404 });
  }
  const { ctx } = resolved;

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
  if (!ctx.realWeekId) {
    return Response.json(
      { success: false, error: "주차 매핑을 해석할 수 없어 보완을 진행할 수 없습니다." },
      { status: 409 },
    );
  }
  if (!ctx.organizationSlug) {
    return Response.json(
      { success: false, error: "대상 크루의 조직을 확인할 수 없습니다." },
      { status: 422 },
    );
  }

  const modeRaw = typeof b.mode === "string" ? b.mode : request.nextUrl.searchParams.get("mode");
  const mode = modeRaw === "test" ? "test" : "operating";

  try {
    const { actId, awardId } = await createActSupplement({
      organization: ctx.organizationSlug,
      mode,
      adminId: admin.userId,
      userId: ctx.userId,
      weekId: ctx.realWeekId,
      actName,
      reason: reason || null,
      pointA,
      pointB,
      pointC,
    });

    const refreshed = await getCrewWeekActDetail(user_id, week_id);
    const weekDetail = refreshed.ok ? refreshed.data : null;

    return Response.json({
      success: true,
      data: { createdActId: actId, createdAwardId: awardId, weekDetail },
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) {
      return Response.json(
        { success: false, error: error instanceof Error ? error.message : "액트 보완에 실패했습니다." },
        { status },
      );
    }
    console.error("[admin/members/:user_id/weeks/:week_id/acts/supplement POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "액트 보완에 실패했습니다." },
      { status: 500 },
    );
  }
}
