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
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import {
  readScopeMode,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { resolveWeekStartDateForWeekId } from "@/lib/seasonRestWeekScope";
import { loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import { resolveCurrentWeekStartDate } from "@/lib/teamWeekPositionOverride";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { resolvePositionAtBatch } from "@/lib/positionResolver";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";

// 현재 URL org 컨텍스트 → organization_slug. 라인 개설 크루는 해당 조직 소속만 매칭한다(org 격리).
//   미지정/무효 = null(통합 모드, 전체 크루). 실무 정보 개설 폼은 항상 org-scoped 로 진입한다.
function readOrganization(request: NextRequest): OrganizationSlug | null {
  const raw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  return isOrganizationSlug(raw) ? raw : null;
}

// org(조직) + mode(운영/테스트) 를 모두 적용해 라인 개설 크루 후보를 조회한다.
//   operating: test_user_markers 전원 제외(실사용자만). test: test_user_markers 만(실사용자 제외).
// 이름만으로 조직/모드를 무시하고 매칭하지 않도록, 매칭 입력 자체를 이 모집단으로 좁힌다.
// 반환에 effective mode 를 함께 실어 보낸다 — 매칭(POST)이 test 모집단에서만 T 접두 제거 비교를
//   켤 수 있도록. mode 는 resolveUserScope 가 QA_HIDE_REAL_USERS 를 반영해 해소한 값(요청 mode 아님).
async function loadScopedCrews(
  request: NextRequest,
): Promise<{ crews: CrewRecord[]; mode: ScopeMode }> {
  const organization = readOrganization(request);
  // 라인 개설 크루 후보 = 현재 모집단(QA_HIDE_REAL_USERS=true 면 test 유저 / 종료 후 실사용자).
  //   화면에 보이는 후보 == 개설 대상이 항상 같은 축(단일 스위치).
  const scope = await resolveUserScope(readScopeMode(request.nextUrl.searchParams), organization);
  const crews = await loadCrewRecords(organization);
  const scoped = scope.filter(crews, (c) => c.userId);
  // 라인 개설/수정 후보 = 집합 ② **실무 평가 가능 모집단**(2026-07-27 정책 확정).
  //   시즌 휴식 · (효력 발생 후) 활동 중단 · 엘리트 · 바사노스를 한 번에 제외한다.
  //   판정은 lib/evaluationEligibility 공통 모듈 단일 경로 — 이 라우트가 상태 문자열을 비교하지 않는다.
  //
  //   opt-in 유지: excludeSeasonRest / excludeGrowthStopped 중 **하나라도** 오면 적용한다.
  //     · 두 플래그는 이제 같은 것(평가 모집단)을 뜻한다 — 종전엔 각각 시즌 휴식 / 성장 중단만 걸러
  //       엘리트·바사노스가 개설 후보에 그대로 남았다(2026-07-27 실측 누수).
  //     · 플래그를 안 보내는 소비처(프로세스 수동부여 등)는 기존 동작 그대로(모집단 무필터).
  //   ⚠ 기준 시점 = week_id 가 속한 주차. 현재 상태를 과거 주차 후보 목록에 소급하지 않는다
  //     (week_id 미전달 시에만 현재 주차 폴백 — 종전 동작 보존).
  const sp = request.nextUrl.searchParams;
  const on = (v: string | null) => v === "1" || v === "true";
  const evaluationPool =
    on(sp.get("excludeSeasonRest")) ||
    on(sp.get("excludeGrowthStopped")) ||
    sp.get("population") === "evaluation";
  if (!evaluationPool) return { crews: scoped, mode: scope.mode };

  const weekStart =
    (await resolveWeekStartDateForWeekId(sp.get("week_id")?.trim() || null)) ??
    (await resolveCurrentWeekStartDate(getCurrentActivityDateIso()));
  if (!weekStart) return { crews: scoped, mode: scope.mode };
  const eligibility = await loadEvaluationEligibility({
    userIds: scoped.map((c) => c.userId),
    weekStartDate: weekStart,
  });
  return { crews: scoped.filter((c) => eligibility.isEvaluable(c.userId)), mode: scope.mode };
}

// 변동 액트(실무 경험 급)의 "소속 팀" 필터(2026-08-03) — team_id + week_id 를 받아 그 주차 실제
//   소속 팀(override→UPH→membership, positionResolver 단일 SoT)이 일치하는 크루만 남긴다.
//   ⚠ 현재 팀(멤버십)이 아니라 **대상 주차 기준 effective 팀** — 저장 검증(assertTargetsBelongToTeamAtWeek)과
//   동일 기준을 써야 "검색에는 나오는데 저장은 거부" 되는 모순이 없다.
async function filterCrewsByTeamAtWeek(
  crews: CrewRecord[],
  organization: OrganizationSlug | null,
  teamId: string,
  weekIdRaw: string | null,
): Promise<CrewRecord[]> {
  if (!organization || !isUuid(teamId)) return [];
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id,team_name,organization_slug")
    .eq("id", teamId)
    .maybeSingle();
  if (error || !data || (data as { organization_slug: string | null }).organization_slug !== organization) {
    return []; // 유효하지 않은 팀/타 조직 팀 — 결과 없음(위조 방어).
  }
  const teamName = (data as { team_name: string }).team_name;
  const weekStart =
    (await resolveWeekStartDateForWeekId(weekIdRaw?.trim() || null)) ??
    (await resolveCurrentWeekStartDate(getCurrentActivityDateIso()));
  if (!weekStart) return [];
  const resolved = await resolvePositionAtBatch({
    userIds: crews.map((c) => c.userId),
    targetWeekStart: weekStart,
    organization,
  });
  return crews.filter((c) => resolved.get(c.userId)?.teamName === teamName);
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
    //    test 모집단이면 크루 이름의 단일 T 접두를 벗겨 실명 댓글과 대조한다(operating 불변).
    const { crews, mode } = await loadScopedCrews(request);
    const result = matchCafeComments(collected.data.nicknames, crews, {
      stripTestPrefix: mode === "test",
    });

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
    // 동명이인이 섞이지 않게 한다. (부분일치 검색이라 "김민지"로 "T김민지"도 이미 걸린다.)
    const { crews } = await loadScopedCrews(request);
    // 변동 액트 실무 경험 급 — team_id 가 오면 그 주차 실제 소속 팀으로 후보를 좁힌다(§클라 위조 방어 겸용).
    const teamIdParam = request.nextUrl.searchParams.get("team_id")?.trim() || null;
    const scoped = teamIdParam
      ? await filterCrewsByTeamAtWeek(
          crews,
          readOrganization(request),
          teamIdParam,
          request.nextUrl.searchParams.get("week_id"),
        )
      : crews;
    const matches = filterCrewRecords(scoped, q).slice(0, 30);
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
