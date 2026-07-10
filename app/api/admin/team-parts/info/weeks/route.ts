import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  loadTeamPartsInfoWeeks,
  DEFAULT_WEEKS_PAGE_SIZE,
  isWeeksSortKey,
  type WeeksSort,
} from "@/lib/adminTeamPartsInfoWeeksData";

// 클럽 정보 > 주차 내역 (read-only).
//   GET ?club=encre|oranke|phalanx&page=1&pageSize=20[&mode=test]
//     → currentWeek 배너 + 주차별 액트/라인 요약 + 주차 검수 여부 + 페이지네이션.
//
// club=all|integrated(통합)은 기획 미정 → 프론트가 API 호출 없이 "준비 중" 안내.
//   방어적으로 여기서도 400 으로 막는다(유효 org 만 허용).
//
// mode(operating/test)는 조회 결과에 영향을 주지 않는다(주차/카탈로그/라인/검수 메타는
//   사용자 모집단과 무관). 링크 컨텍스트 유지용으로만 허용하며 값 파리티가 유지된다.

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const club = params.get("club")?.trim() ?? "";

  if (club === "all" || club === "integrated") {
    return Response.json(
      { success: false, error: "통합 탭은 준비 중입니다." },
      { status: 400 },
    );
  }
  if (!isOrganizationSlug(club)) {
    return Response.json(
      { success: false, error: "유효한 club(encre·oranke·phalanx)이 필요합니다." },
      { status: 400 },
    );
  }

  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(
    params.get("pageSize") ?? String(DEFAULT_WEEKS_PAGE_SIZE),
    10,
  );

  // 서버사이드 정렬 — semantic 키만 whitelist 통과(DB 컬럼명 직접 수용 금지). 무효값은 무시(기본순).
  const sortKeyRaw = params.get("sort")?.trim() ?? "";
  const dirRaw = params.get("dir")?.trim() ?? "";
  let sort: WeeksSort | null = null;
  if (isWeeksSortKey(sortKeyRaw) && (dirRaw === "asc" || dirRaw === "desc")) {
    sort = { key: sortKeyRaw, dir: dirRaw };
  }

  try {
    const data = await loadTeamPartsInfoWeeks({
      organization: club,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : DEFAULT_WEEKS_PAGE_SIZE,
      sort,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/team-parts/info/weeks GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "주차 내역 조회에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
