import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  loadTeamPartsInfoWeeks,
  DEFAULT_WEEKS_PAGE_SIZE,
  isWeeksSortKey,
  type WeeksSort,
} from "@/lib/adminTeamPartsInfoWeeksData";
import { parseScopeMode } from "@/lib/userScopeShared";

// 클럽 정보 > 주차 내역 (read-only).
//   GET ?club=encre|oranke|phalanx&page=1&pageSize=20[&mode=test]
//     → currentWeek 배너 + 주차별 액트/라인 요약 + 주차 검수 여부 + 페이지네이션.
//
// club=all|integrated(통합)은 기획 미정 → 프론트가 API 호출 없이 "준비 중" 안내.
//   방어적으로 여기서도 400 으로 막는다(유효 org 만 허용).
//
// mode(operating/test): 주차/라인/검수 메타·정규 액트 카탈로그는 사용자 모집단과 무관해 mode 불변.
//   ⚠ 단 **변동 액트는 scope_mode 로 갈리므로** 액트 요약(전체/가동/체크/미체크/변동/신청율)은 mode 를 탄다.
//   상세(활동 관리 > 액트 체크 관리)가 동일하게 scope_mode=mode 로 변동을 필터하므로, 목록==상세
//   파리티를 위해 여기서도 mode 를 로더에 전달한다(2026-07-17). 산식/DTO 구조는 두 모드 동일.

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
  const denied = await guardAdminOrgAccess(admin, club);
  if (denied) return denied;

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
      // 변동 액트 스코프 — 상세와 동일 규칙(parseScopeMode: 'test' 외 전부 operating).
      mode: parseScopeMode(params.get("mode")),
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
