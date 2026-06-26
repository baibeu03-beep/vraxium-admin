import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { lookupCrewByCode } from "@/lib/adminTeamHalvesData";

// 팀장 크루코드 [호출] — crew_code 로 등록된 크루를 조회(11개 필드).
//   조회 안 되면 404(팀장 등록 불가). 인물 정보 SoT=기존 크루/프로필.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return Response.json(
      { success: false, error: "크루코드가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const crew = await lookupCrewByCode(code);
    if (!crew) {
      return Response.json(
        {
          success: false,
          error:
            "해당 크루코드의 크루를 찾을 수 없습니다. 팀장은 이미 등록된 크루만 가능합니다.",
        },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: crew });
  } catch (error) {
    console.error("[admin/team-parts/crew-lookup GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "크루 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
