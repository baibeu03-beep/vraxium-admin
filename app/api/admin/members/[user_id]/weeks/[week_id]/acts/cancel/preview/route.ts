import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { resolveCrewWeekContext } from "@/lib/adminCrewWeekActDetail";
import { previewCrewWeekMutationImpact } from "@/lib/crewWeekMutationImpact";
import type { OrganizationSlug } from "@/lib/organizations";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

const MAX_CANCEL_BATCH = 200;

// POST /api/admin/members/[user_id]/weeks/[week_id]/acts/cancel/preview
//   저장 없이 액트 취소가 성장 결과(성공/실패)를 바꾸는지 미리 계산(dry-run). body: { awardIds: string[] }.
//   응답: { before, after, changes:{ growthStatusChanged }, confirmationRequired }.
export async function POST(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  void admin;

  const { user_id, week_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

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
      { success: false, code: "CREW_WEEK_NOT_EDITABLE", error: "진행 중이거나 집계 중인 주차입니다." },
      { status: 403 },
    );
  }
  if (!ctx.realWeekId) {
    return Response.json({ success: false, error: "주차 매핑을 해석할 수 없습니다." }, { status: 409 });
  }

  const impact = await previewCrewWeekMutationImpact({
    userId: ctx.userId,
    weekId: ctx.realWeekId,
    organizationSlug: (ctx.organizationSlug ?? null) as OrganizationSlug | null,
    currentStatus: ctx.card.userWeekStatus,
    mutation: { kind: "cancel", awardIds },
  });

  return Response.json({
    success: true,
    data: {
      before: impact.before,
      after: impact.after,
      changes: { growthStatusChanged: impact.growthStatusChanged },
      confirmationRequired: impact.confirmationRequired,
    },
  });
}
