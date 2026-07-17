import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import {
  listExperienceLineOptionsForCategory,
  createExperienceSuccessLine,
} from "@/lib/adminExperienceLineSelect";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// GET /api/admin/members/[user_id]/weeks/[week_id]/experience-lines?category=<code>
//   오픈+비대상(강화 실패) 실무 경험 슬롯을 강화 성공으로 전환 시 선택 가능한 라인 옵션(유형 스코프).
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id } = await params;
  const category = request.nextUrl.searchParams.get("category")?.trim() ?? "";

  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const result = await listExperienceLineOptionsForCategory(user_id, week_id, category);
    if (!result.ok) {
      if (result.reason === "invalid_category") {
        return Response.json({ success: false, error: "알 수 없는 실무 경험 유형입니다." }, { status: 422 });
      }
      const message = result.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({
      success: true,
      data: { category: result.category, label: result.label, options: result.options },
    });
  } catch (error) {
    console.error("[admin/.../experience-lines GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load experience options" },
      { status: 500 },
    );
  }
}

// POST /api/admin/members/[user_id]/weeks/[week_id]/experience-lines
//   { masterId, category, confirmGrowthFlip, mode } → 선택 라인으로 이 크루 전용 경험 라인 인스턴스 +
//   대상자 + 평점(>=4) 생성 = 강화 성공. 지급/집계/snapshot 수렴은 라인 저장과 동일 SoT.
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
  const category = typeof b.category === "string" ? b.category.trim() : "";
  if (!masterId) {
    return Response.json(
      { success: false, error: "강화 성공으로 저장하려면 실무 경험 라인을 선택해주세요." },
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
    const result = await createExperienceSuccessLine(
      user_id,
      week_id,
      masterId,
      category,
      admin.userId,
      confirmGrowthFlip,
    );
    if (!result.ok) {
      return Response.json(
        { success: false, error: result.error, growth: result.growth },
        { status: result.code },
      );
    }
    return Response.json({ success: true, data: { lineId: result.lineId, lineTargetId: result.lineTargetId } });
  } catch (error) {
    console.error("[admin/.../experience-lines POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create experience line" },
      { status: 500 },
    );
  }
}
