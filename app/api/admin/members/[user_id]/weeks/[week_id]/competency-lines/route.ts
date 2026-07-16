import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import {
  listCompetencyMasterOptionsForWeek,
  createCompetencySuccessLine,
} from "@/lib/adminCompetencyLineSelect";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// GET /api/admin/members/[user_id]/weeks/[week_id]/competency-lines
//   실무 역량 강화 성공 전환 시 선택 가능한 역량 활동 마스터 옵션(주차·조직 개설분, 이미 배정분 제외).
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id } = await params;

  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const result = await listCompetencyMasterOptionsForWeek(user_id, week_id);
    if (!result.ok) {
      const message = result.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({ success: true, data: { options: result.options } });
  } catch (error) {
    console.error("[admin/.../competency-lines GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load competency options" },
      { status: 500 },
    );
  }
}

// POST /api/admin/members/[user_id]/weeks/[week_id]/competency-lines
//   { masterId, confirmGrowthFlip, mode } → 선택한 역량 마스터로 이 크루 전용 라인 인스턴스 + 대상자 생성
//   = 강화 성공. 지급/집계/2차 기입/snapshot 수렴은 라인 저장과 동일 SoT.
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
  const masterId = typeof b.masterId === "string" ? b.masterId.trim() : "";
  if (!masterId) {
    return Response.json(
      { success: false, error: "강화 성공으로 저장하려면 실무 역량 라인을 선택해주세요." },
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

  try {
    const confirmGrowthFlip = b.confirmGrowthFlip === true;
    const result = await createCompetencySuccessLine(user_id, week_id, masterId, admin.userId, confirmGrowthFlip);
    if (!result.ok) {
      return Response.json(
        { success: false, error: result.error, growth: result.growth },
        { status: result.code },
      );
    }
    return Response.json({ success: true, data: { lineId: result.lineId, lineTargetId: result.lineTargetId } });
  } catch (error) {
    console.error("[admin/.../competency-lines POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create competency line" },
      { status: 500 },
    );
  }
}
