// 클럽 정보 > 주차 내역 > 활동 관리 — [오픈 확인].
//   POST ?club=encre|oranke|phalanx  body: { config: { practicalInfo, practicalExperience, practicalCompetency } }
//     → 체크 상태를 주차×클럽 오픈 설정으로 저장하고 open_confirmed=true.
//   검수(review)와 무관. snapshot 무접촉(cluster4_week_opening_configs 만 write).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  saveWeekOpenConfirm,
  revertWeekOpenConfirm,
  WeekDetailWriteError,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

type Ctx = { params: Promise<{ weekId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = admin.userId;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  const club = request.nextUrl.searchParams.get("club")?.trim() ?? "";
  if (!isOrganizationSlug(club)) {
    return Response.json(
      { success: false, error: "유효한 club(encre·oranke·phalanx)이 필요합니다." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const config = (body as { config?: unknown } | null)?.config ?? {};

  try {
    const result = await saveWeekOpenConfirm({ weekId, organization: club, config, actorId });
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/open-confirm POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "오픈 확인 저장에 실패했습니다." },
      { status: 500 },
    );
  }
}

// [오픈 확인 취소] — ↩ 실행 취소. 직전 단계("오픈 확인 전") 복원(open_confirmed=false, config 보존).
//   POST 와 동일 인증·검증. snapshot 무접촉이라 재계산 없음(멱등).
export async function DELETE(request: NextRequest, { params }: Ctx) {
  let actorId: string | null = null;
  try {
    const admin = await requireAdmin(ADMIN_WRITE_ROLES);
    actorId = admin.userId;
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  const club = request.nextUrl.searchParams.get("club")?.trim() ?? "";
  if (!isOrganizationSlug(club)) {
    return Response.json(
      { success: false, error: "유효한 club(encre·oranke·phalanx)이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const result = await revertWeekOpenConfirm({ weekId, organization: club, actorId });
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/open-confirm DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "오픈 확인 취소에 실패했습니다." },
      { status: 500 },
    );
  }
}
