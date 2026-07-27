import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;

  try {
    const crews = await listCrewsForTargetSelection({
      organization: params.get("organization")?.trim() || null,
      team: params.get("team")?.trim() || null,
      part: params.get("part")?.trim() || null,
      membershipLevel: params.get("membershipLevel")?.trim() || null,
      status: params.get("status")?.trim() || null,
      search: params.get("q")?.trim() || null,
      mode: parseScopeMode(params.get("mode")),
      // 조회 기준 주차 — 소속(effective 배정)과 시즌 휴식 제외의 기준 시점.
      //   미전달 시 현재 주차/현재 시즌(종전 동작). 화면은 반드시 명시 전달할 것.
      weekId: params.get("week_id")?.trim() || null,
    });
    return Response.json({ success: true, data: crews });
  } catch (error) {
    console.error("[admin/cluster4/crews GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
