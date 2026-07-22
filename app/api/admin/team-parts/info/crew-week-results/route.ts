import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import {
  guardAdminOrgAccess,
  resolveAdminOrgAccess,
} from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import {
  getCrewWeeklyResultsBundle,
  CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE,
} from "@/lib/crewWeeklyResultProjection";

// 클럽 정보 > 주차 결과(크루) (read-only).
//   GET ?[organization=encre|oranke|phalanx][&mode=test][&page=1&pageSize=20]
//
// **하나의 라우트가 통합 목록과 클럽 상세를 모두 서빙한다.**
//   · organization 미지정 = 통합 → 이 관리자에게 허용된 조직 전체(resolveAdminOrgAccess).
//   · organization 지정   = 클럽 상세 → 그 조직 1개(guardAdminOrgAccess 로 403 게이트).
//   통합/개별/테스트 어느 경로든 같은 서비스(getCrewWeeklyResultsBundle)·같은 DTO 를 쓴다.
//   통합 셀과 상세 셀이 구조적으로 같은 값일 수밖에 없는 이유가 이것이다(분기 없음).
//
// mode(operating/test): 사용자 컨텍스트만 바꾼다. 검수 상태 scope(resolveOrgResultScope) 하나만
//   달라지고, 쿼리/판정/DTO 키는 완전히 동일하다. mode 전용 분기·mode 전용 DTO 는 없다.
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const orgRaw = params.get("organization")?.trim() ?? "";

  let organizations;
  if (orgRaw === "") {
    // 통합 — 허용 조직 전체(권한이 곧 스코프). 허용 조직이 없으면 빈 목록으로 응답한다.
    try {
      const access = await resolveAdminOrgAccess(admin);
      organizations = access.allowedOrgs;
    } catch (error) {
      const response = toAdminErrorResponse(error);
      if (response) return response;
      throw error;
    }
  } else {
    if (!isOrganizationSlug(orgRaw)) {
      return Response.json(
        { success: false, error: "유효한 클럽(encre·oranke·phalanx)이 필요합니다." },
        { status: 400 },
      );
    }
    const denied = await guardAdminOrgAccess(admin, orgRaw);
    if (denied) return denied;
    organizations = [orgRaw];
  }

  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(
    params.get("pageSize") ?? String(CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE),
    10,
  );

  try {
    const data = await getCrewWeeklyResultsBundle({
      organizations,
      mode: parseScopeMode(params.get("mode")),
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/crew-week-results GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "주차 결과(크루) 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
