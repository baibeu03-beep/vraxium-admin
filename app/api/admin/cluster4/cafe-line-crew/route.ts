import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { fetchCafeNicknames } from "@/lib/cafeCrawlerClient";
import {
  loadCrewRecords,
  matchCafeComments,
  filterCrewRecords,
} from "@/lib/cluster4CafeLineMatch";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { resolveUserScope, readScopeMode } from "@/lib/userScope";
import { getCurrentSeasonRestUserIds } from "@/lib/currentSeasonRest";

// 현재 URL org 컨텍스트 → organization_slug. 라인 개설 크루는 해당 조직 소속만 매칭한다(org 격리).
//   미지정/무효 = null(통합 모드, 전체 크루). 실무 정보 개설 폼은 항상 org-scoped 로 진입한다.
function readOrganization(request: NextRequest): OrganizationSlug | null {
  const raw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  return isOrganizationSlug(raw) ? raw : null;
}

// org(조직) + mode(운영/테스트) 를 모두 적용해 라인 개설 크루 후보를 조회한다.
//   operating: test_user_markers 전원 제외(실사용자만). test: test_user_markers 만(실사용자 제외).
// 이름만으로 조직/모드를 무시하고 매칭하지 않도록, 매칭 입력 자체를 이 모집단으로 좁힌다.
async function loadScopedCrews(request: NextRequest) {
  const organization = readOrganization(request);
  const scope = await resolveUserScope(
    readScopeMode(request.nextUrl.searchParams),
    organization,
  );
  const crews = await loadCrewRecords(organization);
  const scoped = scope.filter(crews, (c) => c.userId);
  // 라인 개설/수정 후보 한정: 현재 시즌 전체 휴식자(user_season_statuses(현재시즌,rest))를 후보에서 제외한다.
  //   excludeSeasonRest 플래그가 있을 때만 적용 — 라인 개설 UI(CafeCrewPicker/CompetencyApplicantSection)만
  //   전달하고, 프로세스 수동부여 등 비-개설 소비처는 기존 동작을 보존한다(growth_status 미사용·과거 무소급).
  const exParam = request.nextUrl.searchParams.get("excludeSeasonRest");
  if (exParam === "1" || exParam === "true") {
    const restIds = await getCurrentSeasonRestUserIds();
    return scoped.filter((c) => !restIds.has(c.userId));
  }
  return scoped;
}

// 라인 개설 크루 — 카페 링크 검수(POST) + 수동추가 검색(GET).
//   POST 는 fetchCafeNicknames(lib/cafeCrawlerClient)로 댓글 닉네임을 시간순 수집한 뒤,
//   우리 크루 DB 와 엄격 매칭(오매칭 방지 우선)해 자동 매칭 후보 + 수동 확인 목록으로 분리한다.
//   닉네임 수집: 운영(Vercel)=외부 크롤러 서비스 / 로컬=기존 Playwright 경로(보존). 매칭은 항상 여기서.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let url: string;
  try {
    const body = await request.json();
    url = typeof body?.url === "string" ? body.url : "";
  } catch {
    url = "";
  }
  if (!url.trim()) {
    return Response.json(
      { success: false, error: "invalid_url", message: "게시글 URL을 입력해주세요." },
      { status: 400 },
    );
  }

  try {
    // 1) 댓글 닉네임 수집 (운영=크롤러 서비스 / 로컬=Playwright — 시간순 보존).
    const collected = await fetchCafeNicknames(url);
    console.log(
      `[cafe-line-crew] fetchCafeNicknames ok=${collected.ok}` +
        (collected.ok
          ? ` nicknames=${collected.data.uniqueNicknames}`
          : ` error=${collected.error} message=${collected.message}`),
    );
    if (!collected.ok) {
      const status = collected.error === "invalid_url" ? 400 : 502;
      return Response.json(
        { success: false, error: collected.error, message: collected.message },
        { status },
      );
    }

    // 2) 우리 크루 DB(현재 org + mode 모집단) 와 엄격 매칭.
    //    org 외 동명이인·모드 외 사용자(운영↔테스트)는 매칭 입력에서 제외된다.
    const crews = await loadScopedCrews(request);
    const result = matchCafeComments(collected.data.nicknames, crews);

    return Response.json({
      success: true,
      data: {
        cafeUrl: collected.data.articleUrl,
        rawCommentCount: collected.data.totalComments,
        uniqueNicknames: collected.data.uniqueNicknames,
        matchedCrewCount: result.matchedCrewCount,
        reviewCount: result.reviewCount,
        matched: result.matched,
        review: result.review,
      },
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: "match_failed",
        message:
          error instanceof Error ? error.message : "카페 검수 중 오류가 발생했습니다.",
      },
      { status: 500 },
    );
  }
}

// 수동 추가 자동완성 — q 로 우리 크루를 부분일치 검색해 후보 레코드를 돌려준다.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return Response.json({ success: true, data: { crews: [] } });
  }

  try {
    // 수동 추가 검색도 현재 org + mode 모집단으로 한정 — 조직/운영·테스트 경계를 벗어난
    // 동명이인이 섞이지 않게 한다.
    const crews = await loadScopedCrews(request);
    const matches = filterCrewRecords(crews, q).slice(0, 30);
    return Response.json({ success: true, data: { crews: matches } });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: "search_failed",
        message: error instanceof Error ? error.message : "검색 실패",
      },
      { status: 500 },
    );
  }
}
