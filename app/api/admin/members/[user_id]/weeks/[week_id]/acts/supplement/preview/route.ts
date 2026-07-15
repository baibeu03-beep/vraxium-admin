import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { resolveCrewWeekContext } from "@/lib/adminCrewWeekActDetail";
import { previewCrewWeekMutationImpact } from "@/lib/crewWeekMutationImpact";
import type { OrganizationSlug } from "@/lib/organizations";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

function intInRange(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  return n;
}

// POST /api/admin/members/[user_id]/weeks/[week_id]/acts/supplement/preview
//   저장 없이 액트 보완이 성장 결과(성공/실패)를 바꾸는지 미리 계산(dry-run). body: { pointA, pointB, pointC }.
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

  const pointA = intInRange(b.pointA ?? 0);
  const pointB = intInRange(b.pointB ?? 0);
  const pointC = intInRange(b.pointC ?? 0);
  if (pointA === null || pointB === null || pointC === null) {
    return Response.json({ success: false, error: "포인트는 0~20 정수여야 합니다." }, { status: 400 });
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
    mutation: { kind: "supplement", pointA, pointB, pointC },
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
