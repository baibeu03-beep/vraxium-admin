import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getExperienceLineManageSummary } from "@/lib/adminExperienceLineManage";
import { parseScopeMode } from "@/lib/userScope";

// 실무 경험 [라인 관리] 탭 — 팀 요약 보드 데이터(read-only).
//
//   GET /api/admin/cluster4/experience/line-manage?organization={slug}[&week_id={uuid}]
//
// week_id 미지정 → 개설 대상 주차(openable, 금요일 경계). 지정 → 해당 주차로 집계(주차 드롭다운).
// 반환: 대상 주차 + 확장 여부 + 팀별(개설 완료/필요·파트 신청 여부·라인별 강화 결과) + 전체 요약.
// ⚠ 표시 전용 — snapshot/고객 라인 강제 로직·demoUserId 경로 무관(org·주차 스코프).

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || "";
  if (!org) {
    return Response.json(
      { success: false, error: "organization 은 필수입니다" },
      { status: 400 },
    );
  }
  const weekId = request.nextUrl.searchParams.get("week_id")?.trim() || null;
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const data = await getExperienceLineManageSummary(org, weekId, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/experience/line-manage GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "라인 관리 요약을 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}
