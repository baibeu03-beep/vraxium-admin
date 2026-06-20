import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { listMembersRoster } from "@/lib/adminMembersData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { observeApiRoute } from "@/lib/apiObservability";

// GET /api/admin/members/roster?organization=<slug>&mode=<operating|test>
//
// /admin/members "크루 목록" 탭 전용 — 페이지네이션 없이 (조직 + 모집단 스코프) 전원 +
// 표시 성장상태·성장 주차·품계·누적 포인트·일정 신뢰도·활동 완료율을 반환한다.
// 검색/필터/정렬은 클라이언트가 적용한다("결과 값" = 렌더 row 수).
//   organization 미지정 = 전체(전 조직 + 소속 없음 포함).
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;

  const orgParam = params.get("organization")?.trim() || null;
  let organization: OrganizationSlug | null = null;
  if (orgParam) {
    if (isOrganizationSlug(orgParam)) {
      organization = orgParam;
    } else {
      return Response.json(
        { success: false, error: `Unknown organization: ${orgParam}` },
        { status: 400 },
      );
    }
  }

  // 페이지네이션 없는 전원 로스터 — 대량 조회 핫패스. 실행 시간/처리 건수/쿼리/timeout 계측.
  return observeApiRoute("[admin/members/roster GET]", async (obs) => {
    try {
      const data = await listMembersRoster({
        organization,
        mode: parseScopeMode(params.get("mode")),
      });
      obs.processed = Array.isArray(data) ? data.length : undefined;
      return Response.json({ success: true, data });
    } catch (error) {
      console.error("[admin/members/roster GET]", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to load roster",
        },
        { status: 500 },
      );
    }
  });
}
