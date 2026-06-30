import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import {
  loadTeamPartsInfo,
  registerTeamHalf,
  updateTeamHalf,
  markTeamHalfDeletionPending,
  TeamHalfWriteError,
} from "@/lib/adminTeamHalvesData";

// 반기별 팀 정보 [섹션.1].
//   GET    ?organization=&half=  → 반기 옵션 + 선택 반기 팀 목록(SoT=cluster4_team_halves).
//   POST   { organization, halfKey, teamName, ... } → 현재·다음 반기 등록(과거 fail-closed).
//   PUT    { organization, halfKey, teamHalfId, teamName, ... } → 기존 팀 수정.
//   DELETE { organization, halfKey, teamHalfId } → 삭제 대기(is_active=false, 하드삭제 아님).

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
  // ?mode=test → QA(테스트 (T)팀만). 미지정 = operating(운영 팀만). QA 누수 차단.
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await loadTeamPartsInfo(organization, half, undefined, mode);
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

  const { organization, halfKey, teamName, description, leaderCrewCode } =
    (body ?? {}) as {
      organization?: unknown;
      halfKey?: unknown;
      teamName?: unknown;
      description?: unknown;
      leaderCrewCode?: unknown;
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
    typeof teamName !== "string" ||
    typeof description !== "string" ||
    typeof leaderCrewCode !== "string"
  ) {
    return Response.json(
      {
        success: false,
        error: "teamName · description · leaderCrewCode 가 필요합니다.",
      },
      { status: 400 },
    );
  }

  try {
    const { teams } = await registerTeamHalf(
      { organization, halfKey, teamName, description, leaderCrewCode },
      undefined,
      readScopeMode(request.nextUrl.searchParams),
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
        error: error instanceof Error ? error.message : "등록에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
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

  const { organization, halfKey, teamHalfId, teamName, description, leaderCrewCode } =
    (body ?? {}) as {
      organization?: unknown;
      halfKey?: unknown;
      teamHalfId?: unknown;
      teamName?: unknown;
      description?: unknown;
      leaderCrewCode?: unknown;
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
    typeof teamHalfId !== "string" ||
    typeof teamName !== "string" ||
    typeof description !== "string" ||
    typeof leaderCrewCode !== "string"
  ) {
    return Response.json(
      {
        success: false,
        error: "teamHalfId · teamName · description · leaderCrewCode 가 필요합니다.",
      },
      { status: 400 },
    );
  }

  try {
    const { teams } = await updateTeamHalf(
      { organization, halfKey, teamHalfId, teamName, description, leaderCrewCode },
      undefined,
      readScopeMode(request.nextUrl.searchParams),
    );
    return Response.json({ success: true, data: { teams } });
  } catch (error) {
    if (error instanceof TeamHalfWriteError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/team-parts/info PUT]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "수정에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
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

  const { organization, halfKey, teamHalfId } = (body ?? {}) as {
    organization?: unknown;
    halfKey?: unknown;
    teamHalfId?: unknown;
  };

  if (typeof organization !== "string" || !isOrganizationSlug(organization)) {
    return Response.json(
      { success: false, error: "유효한 organization 이 필요합니다." },
      { status: 400 },
    );
  }
  if (typeof halfKey !== "string" || typeof teamHalfId !== "string") {
    return Response.json(
      { success: false, error: "halfKey · teamHalfId 가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const { teams } = await markTeamHalfDeletionPending(
      organization,
      halfKey,
      teamHalfId,
      undefined,
      readScopeMode(request.nextUrl.searchParams),
    );
    return Response.json({ success: true, data: { teams } });
  } catch (error) {
    if (error instanceof TeamHalfWriteError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/team-parts/info DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "삭제에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
