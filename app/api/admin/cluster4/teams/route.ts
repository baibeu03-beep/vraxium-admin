import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listTeams } from "@/lib/adminExperienceLineData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org =
    request.nextUrl.searchParams.get("organization")?.trim() || null;
  // 모집단 모드(operating 기본 / test). 팀 목록 스코프는 listTeams 가 filterTeamsByScope
  // 단일 helper 로 적용한다(operating=운영 팀만 / test=(T) 테스트 팀만, 인라인 쿼리·필터 제거).
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const teams = await listTeams(org, mode);
    return Response.json({ success: true, data: teams });
  } catch (error) {
    console.error("[admin/cluster4/teams GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list teams",
      },
      { status: 500 },
    );
  }
}
