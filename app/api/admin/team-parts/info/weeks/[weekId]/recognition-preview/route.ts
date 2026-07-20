// 클럽 정보 > 주차 내역 > 활동 관리 — [활동 인정 개수 N] 미리보기(read-only).
//   POST ?club=encre|oranke|phalanx  body: { config: {...현재 미저장 오픈 설정...} }
//     → 저장하지 않고, 넘어온 config 로 N(활동 인정 개수)을 계산만 해서 돌려준다.
//   화면 체크박스 변경마다 호출해 표시 N 을 즉시 재계산하는 용도. [오픈 확인] 저장 흐름과
//   **동일한** prepareWeekRecognition(순수 read+compute)을 재사용하므로, 표시 N 과 저장/스냅샷/
//   집계에 쓰이는 N 이 완전히 같다(SoT 분기 없음). write 없음 → 읽기 권한으로 충분.
//   org 만 입력(모드 무관) — 일반/mode=test/actAsTestUserId/demoUserId 동일 결과.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import { previewWeekRecognition } from "@/lib/adminTeamPartsInfoWeekDetailData";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ weekId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
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
  if (club === "all" || club === "integrated") {
    return Response.json({ success: false, error: "통합 탭은 준비 중입니다." }, { status: 400 });
  }
  if (!isOrganizationSlug(club)) {
    return Response.json(
      { success: false, error: "유효한 club(encre·oranke·phalanx)이 필요합니다." },
      { status: 400 },
    );
  }
  const denied = await guardAdminOrgAccess(admin, club);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const config = (body as { config?: unknown } | null)?.config ?? {};

  try {
    const data = await previewWeekRecognition({ weekId, organization: club, config });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/weeks/[weekId]/recognition-preview POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "인정 개수 계산에 실패했습니다." },
      { status: 500 },
    );
  }
}
