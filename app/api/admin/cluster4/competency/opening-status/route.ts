import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScope";
import { getCompetencyOpeningStatus } from "@/lib/adminCompetencyLineOpening";

// 실무 역량 라인 개설 상태창(운영 대시보드) 데이터 — read-only.
//
//   GET /api/admin/cluster4/competency/opening-status?organization={slug}
//
// 반환:
//   currentWeek : 이번 주(N)
//   targetWeek  : 지난 주(개설 대상, 금요일 경계 = openable week). experience 상태 API 와 동일 SoT 헬퍼.
//   opened      : 대상 주차에 활성(그 조직 소유) 역량 라인이 ≥1 이면 true (허브 전체 1판정).
//
// ⚠ 표시 전용. snapshot/개설 강제 로직·demoUserId 경로 무관. org 스코프이므로 demo/일반 동일 DTO.

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const orgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const org = isOrganizationSlug(orgRaw) ? orgRaw : null;
  // 운영/테스트 모드 — 개설 대상 주차 판정에 사용(테스트 모드 W13 예외와 동일 SoT).
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    const data = await getCompetencyOpeningStatus(org, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/competency/opening-status GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "상태창 데이터를 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}
