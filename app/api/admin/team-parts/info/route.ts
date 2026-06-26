import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  loadTeamPartsInfo,
  saveCurrentHalfTeams,
  TeamHalfWriteError,
} from "@/lib/adminTeamHalvesData";

// 반기별 팀 정보 [섹션.1].
//   GET ?organization=&half=  → 반기 옵션 + 선택 반기 팀 목록(SoT=cluster4_team_halves).
//   POST { organization, halfKey, teamNames } → 현재 반기만 저장(과거 fail-closed).

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const organization = request.nextUrl.searchParams.get("organization")?.trim();
  if (!organization || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }

  const half = request.nextUrl.searchParams.get("half")?.trim() || null;

  try {
    const data = await loadTeamPartsInfo(organization, half);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "팀 정보 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const { organization, halfKey, teamNames } = (body ?? {}) as {
    organization?: unknown;
    halfKey?: unknown;
    teamNames?: unknown;
  };

  if (typeof organization !== "string" || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }
  if (typeof halfKey !== "string") {
    return Response.json(
      { success: false, error: "halfKey 가 필요합니다." },
      { status: 400 },
    );
  }
  if (
    !Array.isArray(teamNames) ||
    !teamNames.every((t) => typeof t === "string")
  ) {
    return Response.json(
      { success: false, error: "teamNames 는 문자열 배열이어야 합니다." },
      { status: 400 },
    );
  }

  try {
    const teams = await saveCurrentHalfTeams(
      organization,
      halfKey,
      teamNames as string[],
    );
    return Response.json({ success: true, data: { teams } });
  } catch (error) {
    if (error instanceof TeamHalfWriteError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/team-parts/info POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
