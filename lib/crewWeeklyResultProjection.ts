// 클럽 정보 > 주차 결과(크루) — 공통 도메인 서비스(단일 SoT 투영). **서버 전용**(supabaseAdmin).
//
// 이 파일은 **새 상태/새 집계/새 저장소를 만들지 않는다.** 이미 운영 중인 SoT 를 읽어
//   "주차 × 조직" 셀 하나로 투영(projection)할 뿐이다. 통합 목록 · 통합에서 진입한 클럽 상세 ·
//   개별 어드민의 클럽 상세 · mode=test / actAsTestUserId / demoUserId 경로가 **전부 이 함수 하나**를
//   호출한다(사용자·조직 컨텍스트를 정하는 부분만 다르고, 조회·계산·DTO 생성은 동일).
//
//   ⚠ DTO 타입과 순수 판정 함수는 브라우저 안전 모듈 lib/crewWeeklyResultTypes 에 있다.
//     화면 컴포넌트는 **거기서만** 값을 import 한다(이 파일을 import 하면 서버 그래프가 클라이언트
//     번들로 끌려온다). 이 파일은 하위호환을 위해 그대로 re-export 한다.
//
// ── 필드별 SoT (구현 전 추적 결과) ────────────────────────────────────────────
//   클럽 목록/명칭    = lib/organizations (ORGANIZATIONS · organizationLabelKo)
//                       ⚠ URL/식별자는 항상 slug(불변), 한글명은 표시 전용.
//   주차/시즌/기간     = loadSeasonWeeks (season_definitions + weeks + official_rest_periods)
//                       = "주차 활동(클럽)"(/admin/team-parts/info/weeks) 와 **완전히 같은 로더**.
//                       주차명 문자열도 여기서 조합하지 않고 weekBannerName/weekTableName/weekRangeLabel
//                       (adminTeamPartsInfoWeeksData 의 공용 formatter)를 재사용한다.
//   공식 활동/공식 휴식 = SeasonWeekDto.is_official_rest (weeks.is_official_rest ∪ official_rest_periods).
//                       주차 전역 속성이며 조직별로 갈리지 않는다.
//   고객 앱 활동 가능   = cluster4_week_opening_configs.open_confirmed (주차 × 조직).
//                       판정 규칙 SoT = lib/weekOpenGate ("오픈 확인 전에는 아무 것도 가동/오픈 아님").
//                       여기서는 **읽기만** 하고 재해석하지 않는다.
//   집계/검수/공표 상태 = cluster4_week_org_result_states (week_id, organization_slug, scope)
//                       status ∈ aggregating / reviewing / published. 헬퍼 lib/weekOrgResultState.
//                       행이 없으면 resolveWeekOrgResultState 의 레거시 폴백(weeks.result_reviewed_at).
//                       ⚠ 이 테이블이 "검수 완료"의 유일한 SoT 다. 날짜로 완료를 만들어내지 않는다.
//   전역 공표 시각      = weeks.result_published_at (주차 전역). "결과가 존재/노출 가능한가"의 신호로만
//                       쓰고, 조직 검수 완료로 승격시키지 않는다(집계 대기 vs 검수 대기 구분용).
//   현재 시각          = getCurrentActivityDateIso() (활동 기준일 · 00:01 KST 경계 SoT).
//                       ⚠ new Date() 직접 사용 금지. 검증/재현을 위해 today 로 주입 가능하다.
//
// ── 상태 판정 원칙 ────────────────────────────────────────────────────────────
//   시간은 "활동 입력 기간이 끝났는가" 한 가지만 결정한다. **완료 여부는 언제나 데이터가 정한다.**
//     · 조직 상태가 published 면 → 날짜와 무관하게 검수 완료.
//     · 조직 상태가 published 가 아니면 → 다음 주가 됐어도 절대 완료로 표시하지 않는다(집계 중).
//   즉 "다음 주 월요일이 지났으므로 검수 완료" 같은 시간 기반 승격은 이 파일에 없다. 집계가 실패했거나
//   관리자가 검수를 안 했다면 계속 "집계 중"으로 남고, 그것이 고객 앱(growthCore: aggregating/reviewing
//   → tallying)과 동일한 사실이다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks, type SeasonWeekDto } from "@/lib/adminSeasonWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  weekBannerName,
  weekTableName,
  weekRangeLabel,
} from "@/lib/adminTeamPartsInfoWeeksData";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
} from "@/lib/weekOrgResultState";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  loadCrewWeeklyMetricsInputs,
  computeCrewWeeklyMetrics,
  EMPTY_CREW_WEEKLY_METRICS,
  MASKED_CREW_WEEKLY_METRICS,
} from "@/lib/crewWeeklyMetricsAggregation";
import { loadActiveRunsByWeek } from "@/lib/crewWeekPublish";
import {
  CREW_WEEKLY_ACTIVITY_LABEL,
  CREW_WEEKLY_DISPLAY_STATUS_LABEL,
  CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE,
  CREW_WEEKLY_RESULTS_MAX_PAGE_SIZE,
  crewWeeklyCellKey,
  resolveCrewWeeklyLifecycle,
  toCrewWeeklyDisplayStatus,
  type CrewWeeklyActivityKind,
  type CrewWeeklyResultCellDto,
  type CrewWeeklyResultOrganizationDto,
  type CrewWeeklyResultWeekDto,
  type CrewWeeklyResultsBundleDto,
  type CrewWeeklyResultsPagination,
} from "@/lib/crewWeeklyResultTypes";

// 타입/순수 함수는 브라우저 안전 모듈이 소유한다 — 여기서는 서버 소비자 편의를 위해 re-export 만 한다.
export * from "@/lib/crewWeeklyResultTypes";

// ── 벌크 로더(기존 테이블 · 기존 컬럼) ────────────────────────────────────────

// weeks.result_published_at (주차 전역) — 조직 검수와 별개인 "결과 공표" 신호.
async function loadGlobalPublishedAt(
  weekIds: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (weekIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,result_published_at")
    .in("id", weekIds);
  if (error) {
    console.warn(
      "[crew-week-results] weeks.result_published_at read unavailable:",
      error.message,
    );
    return map;
  }
  for (const row of (data ?? []) as Array<{
    id: string;
    result_published_at: string | null;
  }>) {
    map.set(row.id, row.result_published_at ?? null);
  }
  return map;
}

// weeks.result_reviewed_at (주차 전역) — 조직별 행이 없는 레거시 주차의 폴백 입력.
//   resolveWeekOrgResultState 의 계약대로 "폴백 입력"으로만 쓴다(직접 표시 금지).
async function loadLegacyReviewed(weekIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (weekIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,result_reviewed_at")
    .in("id", weekIds);
  if (error) {
    console.warn(
      "[crew-week-results] weeks.result_reviewed_at read unavailable:",
      error.message,
    );
    return map;
  }
  for (const row of (data ?? []) as Array<{
    id: string;
    result_reviewed_at: string | null;
  }>) {
    map.set(row.id, row.result_reviewed_at != null);
  }
  return map;
}

// cluster4_week_opening_configs.open_confirmed — loadWeekOpeningConfig 와 동일 테이블/컬럼을
//   (주차 × 조직) 벌크로 읽는다(N+1 방지). 판정 규칙은 재작성하지 않고 값만 그대로 노출한다.
//   같은 행에서 기준 포인트 A(recognition_count_n)와 그 근거(A/B)도 함께 읽는다 — 추가 쿼리 0.
type OpeningRow = {
  openConfirmed: boolean;
  recognitionCountN: number | null;
  minPointsA: number | null;
  execPointsB: number | null;
};

async function loadOpeningRows(
  weekIds: string[],
  orgs: OrganizationSlug[],
): Promise<Map<string, OpeningRow>> {
  const map = new Map<string, OpeningRow>();
  if (weekIds.length === 0 || orgs.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select(
      "week_id,organization_slug,open_confirmed,recognition_count_n,min_points_a,exec_points_b",
    )
    .in("week_id", weekIds)
    .in("organization_slug", orgs);
  if (error) {
    console.warn(
      "[crew-week-results] week opening config read unavailable:",
      error.message,
    );
    return map;
  }
  for (const row of (data ?? []) as Array<{
    week_id: string;
    organization_slug: string;
    open_confirmed: boolean | null;
    recognition_count_n: number | null;
    min_points_a: number | null;
    exec_points_b: number | null;
  }>) {
    map.set(crewWeeklyCellKey(row.week_id, row.organization_slug as OrganizationSlug), {
      openConfirmed: row.open_confirmed === true,
      // 기준값 없음은 null 그대로 — 30 폴백 금지(lineAvailability hasRequired=false 와 동일 의미).
      recognitionCountN: row.recognition_count_n ?? null,
      minPointsA: row.min_points_a ?? null,
      execPointsB: row.exec_points_b ?? null,
    });
  }
  return map;
}

// 아직 시작하지 않은 주차인가 — 활동 기준일 < 주차 시작일.
//   start_date 가 없는 비정상 행은 "미래"로 보지 않는다(기존 노출 유지 · 데이터 사고 시 은폐 금지).
export function isFutureWeek(
  weekStartDate: string | null,
  activityDate: string,
): boolean {
  return weekStartDate != null && weekStartDate > activityDate;
}

// 최신 주차가 최상단(week_start_date desc, null 최하단) — 주차 활동(클럽) 목록과 동일 기본순.
function cmpWeekStartDesc(a: SeasonWeekDto, b: SeasonWeekDto): number {
  const av = a.week_start_date;
  const bv = b.week_start_date;
  if (av === bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? 1 : -1;
}

function toWeekDto(r: SeasonWeekDto): CrewWeeklyResultWeekDto {
  const activityKind: CrewWeeklyActivityKind = r.is_official_rest
    ? "official_rest"
    : "official_activity";
  return {
    weekId: r.week_id,
    seasonKey: r.season_key,
    seasonName: r.season_name,
    weekNumber: r.week_number,
    displayName: weekBannerName(r),
    tableName: weekTableName(r),
    startDate: r.week_start_date,
    endDate: r.week_end_date,
    periodLabel: weekRangeLabel(r),
    activityKind,
    activityKindLabel: CREW_WEEKLY_ACTIVITY_LABEL[activityKind],
    isCurrentWeek: r.is_current_week,
  };
}

// ── 메인 서비스 ──────────────────────────────────────────────────────────────
//
// 통합 목록 = organizations 여러 개 · 클럽 상세 = organizations 1개.
//   **호출자가 조직 스코프만 정하고, 그 뒤 조회·판정·DTO 생성은 전부 여기서 동일하게 일어난다.**
//   mode(operating/test)는 검수 상태 scope(resolveOrgResultScope) 하나만 바꾼다 —
//   별도 쿼리/별도 DTO/별도 판정 분기는 존재하지 않는다.
export async function getCrewWeeklyResultsBundle(opts: {
  /** 조회 대상 조직(권한 게이트를 통과한 목록). 비어 있으면 빈 번들. */
  organizations: OrganizationSlug[];
  mode?: ScopeMode;
  page?: number;
  pageSize?: number;
  /** 검증용 활동 기준일 주입(미지정 시 서버 활동 기준일 = 00:01 KST 경계). */
  today?: string;
}): Promise<CrewWeeklyResultsBundleDto> {
  const mode: ScopeMode = opts.mode ?? "operating";
  const scope = resolveOrgResultScope(mode);
  // 조직 순서는 항상 ORGANIZATIONS 정본 순서로 정규화(열 순서가 요청 순서에 흔들리지 않게).
  const orgs = ORGANIZATIONS.filter((o) => opts.organizations.includes(o));

  const pageSize = Math.min(
    CREW_WEEKLY_RESULTS_MAX_PAGE_SIZE,
    Math.max(
      1,
      Math.floor(opts.pageSize ?? CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE) ||
        CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE,
    ),
  );
  const requestedPage = Math.max(1, Math.floor(opts.page ?? 1) || 1);

  const activityDate = opts.today ?? getCurrentActivityDateIso();

  const organizations: CrewWeeklyResultOrganizationDto[] = orgs.map((slug) => ({
    organizationId: slug,
    organizationSlug: slug,
    organizationName: organizationLabelKo(slug),
  }));

  // 1) 주차 행 — 주차 활동(클럽) 목록과 동일 로더·동일 전환 주차 제외 규칙.
  //    전환 주차(다음 시즌 W0)는 클럽 주차 운영 대상이 아니므로 데이터셋 단계에서 제외한다
  //    (표시만 숨기지 않는다 — 개수/페이지네이션도 같은 원천).
  //    ⚠ 미래 주차(아직 시작 안 한 주차)도 데이터셋 단계에서 제외한다 —
  //      결과가 존재할 수 없는 주차를 "진행 중" 결과처럼 노출하던 버그(2026-07-22 수정).
  //      경계 = 활동 기준일(getCurrentActivityDateIso, 00:01 KST) >= 주차 시작일.
  //      today 주입 시에는 그 시점 기준으로 잘리므로 검증에서 재현 가능하다.
  //      표시만 숨기지 않고 개수/페이지네이션까지 같은 원천으로 자른다.
  const { rows } = await loadSeasonWeeks(opts.today);
  const ordered = rows
    .filter((r) => !r.is_transition)
    .filter((r) => !isFutureWeek(r.week_start_date, activityDate))
    .sort(cmpWeekStartDesc);

  const totalCount = ordered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const pageRows = ordered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  const weeks = pageRows.map(toWeekDto);
  const weekIds = pageRows.map((r) => r.week_id);

  const pagination: CrewWeeklyResultsPagination = {
    page,
    pageSize,
    totalCount,
    totalPages,
  };

  if (orgs.length === 0 || weekIds.length === 0) {
    return { organizations, weeks, cells: [], pagination, activityDate, scope, populationSize: 0 };
  }

  // 2) 상태 원천 — 조직별 검수 상태 · 전역 공표/검수 · 오픈 확인(+기준 포인트 A) · 크루 지표 입력.
  //    지표 입력은 조직당 1회만 로드하고 주차 루프에서 재사용한다(주차 수만큼 N+1 금지).
  const [orgStateMaps, publishedAtByWeek, legacyReviewed, openingRows, metricsInputsByOrg, activeRunsByOrg] =
    await Promise.all([
      Promise.all(
        orgs.map(async (org) => ({
          org,
          states: await loadWeekOrgResultStates(weekIds, org, scope),
        })),
      ),
      loadGlobalPublishedAt(weekIds),
      loadLegacyReviewed(weekIds),
      loadOpeningRows(weekIds, orgs),
      Promise.all(
        orgs.map(async (org) => ({
          org,
          // ⚠ raw mode 가 아니라 검수 상태와 **동일한 scope** 를 넘긴다(모집단 일치 보장).
          inputs: await loadCrewWeeklyMetricsInputs(org, scope),
        })),
      ),
      // 공표된 주차의 표시값 원천 — 활성 finalize run snapshot(live 재계산 아님).
      Promise.all(
        orgs.map(async (org) => ({
          org,
          runs: await loadActiveRunsByWeek(weekIds, org, scope),
        })),
      ),
    ]);

  const statesByOrg = new Map(orgStateMaps.map((e) => [e.org, e.states]));
  const inputsByOrg = new Map(metricsInputsByOrg.map((e) => [e.org, e.inputs]));
  const runsByOrg = new Map(activeRunsByOrg.map((e) => [e.org, e.runs]));

  // 3) 셀 투영.
  const cells: CrewWeeklyResultCellDto[] = [];
  for (const row of pageRows) {
    const week = toWeekDto(row);
    const endDate = row.week_end_date;
    // 시간이 결정하는 것은 오직 "집계 창이 열렸는가" 뿐이다(활동 기준일 SoT 기준).
    //   집계 창 = 주차 마지막 날부터(활동 입력 종료). 주차 종료 = 마지막 날을 지남.
    //   end_date 가 없는 비정상 행은 창을 열지 않는다(진행 중 유지 · 완료 위장 방지).
    const aggregationWindowOpen = endDate != null && activityDate >= endDate;
    const weekEnded = endDate != null && activityDate > endDate;
    const publishedAt = publishedAtByWeek.get(row.week_id) ?? null;
    const globallyPublished = publishedAt != null;

    for (const org of orgs) {
      const state = resolveWeekOrgResultState(
        statesByOrg.get(org)?.get(row.week_id),
        row.week_start_date ?? "",
        legacyReviewed.get(row.week_id) === true,
      );
      const lifecycleStatus = resolveCrewWeeklyLifecycle({
        orgStatus: state.status,
        // 로더가 이미 미래 주차를 걸렀지만, 순수 함수도 독립적으로 방어한다(경로 이중화).
        notStarted: isFutureWeek(row.week_start_date, activityDate),
        aggregationWindowOpen,
        weekEnded,
        globallyPublished,
      });
      const displayStatus = toCrewWeeklyDisplayStatus(lifecycleStatus);
      const opening = openingRows.get(crewWeeklyCellKey(row.week_id, org));
      const inputs = inputsByOrg.get(org);
      // 결과 지표는 **검수 완료(review_completed)** 에서만 노출한다.
      //   진행 중/집계 대기/집계 중/검수 대기에서는 uws 행이 아직 없어 "행 없음=실패" 규칙이
      //   전원을 실패로 만든다(실측: 여름 W2 = 도전 120 중 120명이 행 없음). 고객 앱도 isTallying
      //   동안 모든 KPI 를 'N' 으로 가린다 → 동일 규칙으로 마스킹한다.
      //   ⚠ 공식 휴식 주차는 예외 없이 하드 0(고객 앱과 동일) — 마스킹 대상이 아니다.
      // 공표된 주차 = **활성 run snapshot** 이 표시값이다(live 재계산 금지 — 공표 후 소속/휴식/
      //   override 가 바뀌어도 값이 변하면 안 된다). legacy run(snapshot 미보유)은 null 로 남긴다.
      const activeRun = runsByOrg.get(org)?.get(row.week_id) ?? null;
      const hasSnapshot = activeRun?.snapshot_captured === true;
      const metricsAvailable =
        (displayStatus === "completed" && hasSnapshot) ||
        week.activityKind === "official_rest";
      const metrics = !metricsAvailable
        ? MASKED_CREW_WEEKLY_METRICS
        : hasSnapshot && activeRun
          ? {
              memberCount: activeRun.member_count,
              seasonRestCount: activeRun.season_rest_count,
              personalRestCount: activeRun.personal_rest_count,
              growthChallengeCount: activeRun.growth_challenge_count,
              growthSuccessCount: activeRun.growth_success_count,
              growthFailureCount: activeRun.growth_failure_count,
              growthSuccessRatePercent: activeRun.growth_success_rate_percent,
              growthChallengeRatePercent: activeRun.growth_challenge_rate_percent,
            }
          : inputs
            ? computeCrewWeeklyMetrics({
                inputs,
                weekStartDate: row.week_start_date ?? "",
                weekEndDate: row.week_end_date ?? "",
                seasonKey: row.season_key,
                isOfficialRest: week.activityKind === "official_rest",
              })
            : EMPTY_CREW_WEEKLY_METRICS;
      // 확정 aggregate override(weekly_league_success_overrides) 적용 여부 — 표시값의 출처 표기.
      const metricsFromAdminOverride =
        metricsAvailable &&
        week.activityKind !== "official_rest" &&
        inputs?.successOverrideByWeekStart.has(row.week_start_date ?? "") === true;
      // 공표 snapshot 이 있으면 기준 포인트 A 도 공표 당시 값을 우선한다(현재 config 가 아님).
      const criterionPointA = hasSnapshot
        ? (activeRun?.criterion_point_a ?? null)
        : (opening?.recognitionCountN ?? null);

      cells.push({
        organizationId: org,
        organizationSlug: org,
        organizationName: organizationLabelKo(org),
        weekId: row.week_id,
        activityKind: week.activityKind,
        activityKindLabel: week.activityKindLabel,
        lifecycleStatus,
        displayStatus,
        displayStatusLabel: CREW_WEEKLY_DISPLAY_STATUS_LABEL[displayStatus],
        reviewStatus: state.status,
        reviewStatusSource: state.source,
        openConfirmed: opening?.openConfirmed === true,
        // 조직별 행이 실제로 published 인 경우만 "수동 검수 완료" — 레거시 날짜 폴백은 제외한다.
        isManuallyCompleted:
          state.status === "published" && state.source === "organization",
        completedAt: state.publishedAt ?? null,
        publishedAt,
        resultVersion: null,
        // 수동 검수 완료 가능 = 집계 중 표시 + 주차가 실제로 끝남(진행 중 주차 확정 금지 —
        //   markTeamPartsWeekReviewed 의 current_or_future_week 가드와 동일한 사실).
        canCompleteManually: displayStatus === "aggregating" && weekEnded,
        // 기준 포인트 A — 오픈 확인 시점 확정값. 없으면 null(30 폴백 금지).
        criterionPointA,
        criterionMinPointsA: opening?.minPointsA ?? null,
        criterionExecPointsB: opening?.execPointsB ?? null,
        ...metrics,
        publishedRunId: activeRun?.id ?? null,
        publishedAt2: null,
        metricsAvailable,
        metricsFromAdminOverride,
      });
    }
  }

  const populationSize = [...inputsByOrg.values()].reduce((n, i) => n + i.roster.length, 0);
  return { organizations, weeks, cells, pagination, activityDate, scope, populationSize };
}
