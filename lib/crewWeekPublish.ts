// 주차 결과(크루) — 예비 검수 / 공표 / 공표 취소 도메인 서비스. **서버 전용**.
//
// 세 동작을 명확히 분리한다(혼동 금지):
//   · 예비 검수(preview)  = 현재 원천을 live 계산해 **돌려주기만** 한다. 저장 0 · 다른 화면 영향 0.
//   · 공표(publish)       = 서버가 **원천을 다시 조회·재계산**한 뒤 finalize run + crew rows 를 저장하고
//                           org 검수 상태를 published 로 전환한다. 클라이언트가 보낸 숫자는 신뢰하지 않는다.
//   · 공표 취소(unpublish) = 활성 run 에 reverted_at 을 찍어 비노출로 만들고 상태를 되돌린다(물리 DELETE 금지).
//
// 조회 규약:
//   공표된 주차의 표시값은 **활성 run(reverted_at IS NULL, snapshot_captured=true) 의 snapshot** 이다.
//   live roster 재계산으로 폴백하지 않는다 — 공표 후 소속/휴식/override 가 바뀌어도 값이 변하면 안 되기 때문.
//   legacy run(snapshot_captured=false, 2026-07-22 이전 12행)은 snapshot 미지원으로 취급한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { seasonKeyToHalfKey } from "@/lib/teamHalf";
import { resolvePositionAtBatch } from "@/lib/positionResolver";
import {
  loadCrewShowcaseInputs,
  collectGradeResolutionFailures,
  computeRanks,
  sortShowcaseRows,
  assertActRateInvariants,
} from "@/lib/crewWeekShowcase";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { organizationLabelKo, type OrganizationSlug } from "@/lib/organizations";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  setWeekOrgResultStatus,
  type OrgResultScope,
  type WeekOrgResultStatus,
} from "@/lib/weekOrgResultState";
import {
  loadCrewWeeklyMetricsInputs,
  computeCrewWeeklyMetrics,
  CREW_METRICS_CALC_VERSION,
  type CrewWeeklyMetricsInputs,
} from "@/lib/crewWeeklyMetricsAggregation";
import type { CrewWeeklyMetrics } from "@/lib/crewWeeklyMetricsAggregation";
import {
  loadCrewWeekTeamContext,
  buildCrewWeekTeamResults,
  assertTeamInvariants,
  type CrewWeekTeamResultDto,
  type TeamVerdict,
} from "@/lib/crewWeekTeamProjection";
// 확정(공표+검수) 본체 = 공통 서비스 단일 SoT. 종전 `/weeks/*` [주차 검수] 와 **같은 함수**를 호출한다
//   — 두 경로가 로직을 복제하지 않는다(lib/weekResultFinalizeCore.ts).
import {
  finalizeWeekResultCore,
  revertWeekResultCore,
  WeekResultFinalizeError,
  type WeekResultFinalizeResult,
  type WeekResultRevertResult,
} from "@/lib/weekResultFinalizeCore";

// ── scope 어휘 변환 ─────────────────────────────────────────────────────────
// DB(cluster4_week_finalize_runs.scope)는 StateScope 어휘 'operating' | 'qa' 를 쓰고,
//   결과 상태 SoT(OrgResultScope)는 'operating' | 'test' 를 쓴다. 두 어휘가 다르므로
//   **문자열을 직접 비교하지 말고 반드시 이 함수를 통한다.**
//   (기존 12행·finalize/revert 소비자가 'qa' 를 쓰고 있어 데이터 일괄 변경은 하지 않는다.)
export type FinalizeRunScope = "operating" | "qa";

export function toFinalizeRunScope(scope: OrgResultScope): FinalizeRunScope {
  return scope === "test" ? "qa" : "operating";
}

export function fromFinalizeRunScope(scope: string | null | undefined): OrgResultScope {
  return scope === "qa" ? "test" : "operating";
}

// ── DTO ─────────────────────────────────────────────────────────────────────
export type CrewWeekCrewResultKind =
  | "success"
  | "failure"
  | "rest"
  | "not_applicable"
  | "pending";

export type CrewWeekCrewResultDto = {
  userId: string;
  crewDisplayName: string | null;
  crewCode: string | null;
  organizationSlug: OrganizationSlug;
  teamName: string | null;
  partName: string | null;
  isSeasonRest: boolean;
  isPersonalRest: boolean;
  isGrowthChallenge: boolean;
  result: CrewWeekCrewResultKind;
  uwsStatus: string | null;
  criterionPointA: number | null;
  earnedPointA: number | null;
  reasonCode: string;

  // ── 크루 표 14컬럼 base row(예비 전에도 표시) ──────────────────────────
  schoolName: string | null;
  majorName: string | null;
  /** week-effective 클래스 — team/part 와 같은 resolver 산출. */
  classLabel: string | null;
  grade: number | null;
  gradeLabel: string | null;

  // ── 결과 overlay(예비/공표에서만 채워짐. null = "-") ────────────────────
  rank: number | null;
  pointB: number | null;
  pointC: number | null;
  actCompletionRatePercent: number | null;
  actTotalCount: number | null;
  actSuccessCount: number | null;
  weeklyGrowthRatePercent: number | null;
  cumulativeSuccessWeeks: number | null;
};

// 지표별 집계 준비 상태 — "-"(미집계)와 0(실제 0)을 구분하기 위한 근거.
//   ready = 원천이 모두 로드되어 값이 확정 · unavailable = 원천 미로드(값 null).
//   ⚠ null 을 0 으로 대체하는 폴백은 어디에도 두지 않는다.
export type MetricReadiness = "ready" | "partial" | "unavailable";

export type CrewWeekMetricsReadiness = {
  memberCount: MetricReadiness;
  seasonRestCount: MetricReadiness;
  personalRestCount: MetricReadiness;
  growthChallengeCount: MetricReadiness;
  growthSuccessCount: MetricReadiness;
  growthFailureCount: MetricReadiness;
  growthSuccessRatePercent: MetricReadiness;
  growthChallengeRatePercent: MetricReadiness;
};

export type CrewWeekResultPayload = CrewWeeklyMetrics & {
  metricsReadiness: CrewWeekMetricsReadiness;
  organizationSlug: OrganizationSlug;
  weekId: string;
  criterionPointA: number | null;
  crewResults: CrewWeekCrewResultDto[];
  /** 팀 활동 결과 — 크루 결과와 **같은 시점·같은 verdict** 에서 파생(재계산 없음). */
  teamResults: CrewWeekTeamResultDto[];
  calculatedAt: string;
  calculationVersion: number;
  sourceActivityDate: string;
};

/** 예비 결과 — 저장되지 않았음을 타입으로 못박는다. */
export type CrewWeekPreviewResultDto = CrewWeekResultPayload & {
  kind: "preview";
  published: false;
  /**
   * 품계 계산에 **실패**한 크루(정상 제외 not-eligible 은 포함하지 않는다).
   * 비어 있지 않으면 공표가 차단된다 — 예비 화면이 미리 경고할 수 있도록 함께 내려준다.
   */
  gradeResolutionFailures: Array<{
    userId: string;
    displayName: string | null;
    reason: string;
  }>;
};

/** 공표 결과 — 활성 run snapshot 에서 읽은 값. */
export type CrewWeekPublishedResultDto = CrewWeekResultPayload & {
  kind: "published";
  published: true;
  runId: string;
  publishedAt: string;
  publishedBy: string | null;
  /** legacy run(snapshot 미보유)이면 true — 지표는 전부 null 이다. */
  snapshotUnavailable: boolean;
};

// ── 공통: 주차 메타 ─────────────────────────────────────────────────────────
type WeekMeta = {
  id: string;
  season_key: string | null;
  start_date: string;
  end_date: string;
  is_official_rest: boolean | null;
  iso_year: number | null;
  iso_week: number | null;
  /** 레거시 전역 검수 시각 — 조직별 상태 행이 없을 때의 폴백 근거(resolveWeekOrgResultState). */
  result_reviewed_at: string | null;
};

async function loadWeekMeta(weekId: string): Promise<WeekMeta | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,season_key,start_date,end_date,is_official_rest,iso_year,iso_week,result_reviewed_at",
    )
    .eq("id", weekId)
    .maybeSingle();
  return (data as WeekMeta | null) ?? null;
}

async function loadCriterionPointA(
  weekId: string,
  organization: OrganizationSlug,
): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("recognition_count_n")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .maybeSingle();
  // 기준값 없음 = null(30 폴백 금지).
  return (data as { recognition_count_n: number | null } | null)?.recognition_count_n ?? null;
}

// 크루별 판정 — computeCrewWeeklyMetrics 와 **동일 순서/동일 규칙**으로 사용자 행을 만든다.
//   집계 숫자와 크루 행이 갈리지 않도록 같은 입력(inputs)에서 파생시킨다.
function buildCrewResults(opts: {
  inputs: CrewWeeklyMetricsInputs;
  organization: OrganizationSlug;
  week: WeekMeta;
  criterionPointA: number | null;
  pointsByUser: Map<string, number>;
}): CrewWeekCrewResultDto[] {
  const { inputs, organization, week, criterionPointA, pointsByUser } = opts;
  const isOfficialRest = week.is_official_rest === true;

  const restUserIds = new Set(
    inputs.restPeriods
      .filter((r) => r.start_date <= week.end_date && r.end_date >= week.start_date)
      .map((r) => r.user_id),
  );

  const out: CrewWeekCrewResultDto[] = [];
  for (const p of inputs.roster) {
    const profile = inputs.profileById?.get(p.user_id);
    const base = {
      userId: p.user_id,
      crewDisplayName: profile?.display_name ?? null,
      crewCode: profile?.crew_code ?? null,
      organizationSlug: organization,
      teamName: profile?.current_team_name ?? null,
      partName: profile?.current_part_name ?? null,
      isSeasonRest: false,
      isPersonalRest: false,
      isGrowthChallenge: false,
      uwsStatus: inputs.statusByUserWeek.get(`${p.user_id}|${week.start_date}`) ?? null,
      criterionPointA,
      earnedPointA: pointsByUser.get(p.user_id) ?? null,
      // base row 기본 정보 — showcase 로더가 이후 단계에서 채운다(여기선 null 초기화).
      schoolName: null,
      majorName: null,
      classLabel: null,
      grade: null,
      gradeLabel: null,
      // 결과 overlay — null = "-". 예비/공표에서만 채워진다.
      rank: null,
      pointB: null,
      pointC: null,
      actCompletionRatePercent: null,
      actTotalCount: null,
      actSuccessCount: null,
      weeklyGrowthRatePercent: null,
      cumulativeSuccessWeeks: null,
    };

    // 공식 휴식 주차 = 전원 판정 대상 아님(집계도 하드 0).
    if (isOfficialRest) {
      out.push({ ...base, result: "not_applicable", reasonCode: "official_rest_week" });
      continue;
    }

    const effectiveStart =
      inputs.memberStartByUser.get(p.user_id) ?? p.activity_started_at ?? null;
    if (!effectiveStart || effectiveStart.slice(0, 10) > week.end_date) {
      out.push({ ...base, result: "not_applicable", reasonCode: "not_started" });
      continue;
    }
    if (week.season_key && inputs.seasonRestByUserSeason.has(`${p.user_id}|${week.season_key}`)) {
      out.push({ ...base, isSeasonRest: true, result: "rest", reasonCode: "season_rest" });
      continue;
    }
    if (restUserIds.has(p.user_id)) {
      out.push({ ...base, isPersonalRest: true, result: "rest", reasonCode: "personal_rest" });
      continue;
    }
    if (base.uwsStatus === "success") {
      out.push({ ...base, isGrowthChallenge: true, result: "success", reasonCode: "uws_success" });
    } else if (base.uwsStatus != null) {
      out.push({
        ...base,
        isGrowthChallenge: true,
        result: "failure",
        reasonCode: `uws_${base.uwsStatus}`,
      });
    } else {
      // uws 행이 없다 — 확정 결과 산출에서는 실패로 세지만(front 규칙), 근거를 반드시 남긴다.
      out.push({
        ...base,
        isGrowthChallenge: true,
        result: "failure",
        reasonCode: "uws_missing",
      });
    }
  }
  return out;
}

// user_weekly_points — 크루별 earned Point A(감사/근거용). 실패해도 판정에는 영향 없음(null).
async function loadEarnedPointA(
  userIds: string[],
  weekStartDate: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (userIds.length === 0) return map;
  for (let i = 0; i < userIds.length; i += 300) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,points")
      .eq("week_start_date", weekStartDate)
      .in("user_id", userIds.slice(i, i + 300));
    if (error) {
      console.warn("[crew-week-publish] user_weekly_points 조회 실패(근거값 생략)", error.message);
      return map;
    }
    for (const r of (data ?? []) as Array<{ user_id: string; points: number | null }>) {
      if (r.points != null) map.set(r.user_id, r.points);
    }
  }
  return map;
}

// ── [3] 예비 검수 — live 계산 · 저장 없음 ───────────────────────────────────
export async function computeCrewWeekPreview(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
  /** 검증용 활동 기준일 주입. */
  today?: string;
  /** 공표 경로 전용 — 품계를 TTL 캐시 없이 지금 시점으로 재계산(계산식·DTO 동일). */
  forceRefreshGrades?: boolean;
}): Promise<CrewWeekPreviewResultDto> {
  const { organization, weekId, scope } = opts;
  const week = await loadWeekMeta(weekId);
  if (!week) throw new CrewWeekPublishError(404, "주차를 찾을 수 없습니다.");

  const [inputs, criterionPointA] = await Promise.all([
    loadCrewWeeklyMetricsInputs(organization, scope),
    loadCriterionPointA(weekId, organization),
  ]);
  const metrics = computeCrewWeeklyMetrics({
    inputs,
    weekStartDate: week.start_date,
    weekEndDate: week.end_date,
    seasonKey: week.season_key,
    isOfficialRest: week.is_official_rest === true,
  });
  const pointsByUser = await loadEarnedPointA(
    inputs.roster.map((r) => r.user_id),
    week.start_date,
  );

  // 원천 로드 실패 → 그 지표는 0 이 아니라 null(화면 "-"). 실제 0 과 구분한다.
  const src = inputs.sourcesLoaded;
  const rdy = (ok: boolean): MetricReadiness => (ok ? "ready" : "unavailable");
  const growthReady = src.roster && src.uws;
  const readiness: CrewWeekMetricsReadiness = {
    memberCount: rdy(src.roster),
    seasonRestCount: rdy(src.roster && src.seasonRest),
    personalRestCount: rdy(src.roster && src.personalRest),
    growthChallengeCount: rdy(growthReady),
    growthSuccessCount: rdy(growthReady),
    growthFailureCount: rdy(growthReady),
    // 비율은 분자·분모가 모두 준비돼야 확정된다.
    growthSuccessRatePercent: rdy(growthReady),
    growthChallengeRatePercent: rdy(growthReady && src.seasonRest && src.personalRest),
  };
  const gated = <K extends keyof CrewWeekMetricsReadiness>(k: K, v: number | null) =>
    readiness[k] === "ready" ? v : null;
  const gatedMetrics = {
    memberCount: gated("memberCount", metrics.memberCount),
    seasonRestCount: gated("seasonRestCount", metrics.seasonRestCount),
    personalRestCount: gated("personalRestCount", metrics.personalRestCount),
    growthChallengeCount: gated("growthChallengeCount", metrics.growthChallengeCount),
    growthSuccessCount: gated("growthSuccessCount", metrics.growthSuccessCount),
    growthFailureCount: gated("growthFailureCount", metrics.growthFailureCount),
    growthSuccessRatePercent: gated("growthSuccessRatePercent", metrics.growthSuccessRatePercent),
    growthChallengeRatePercent: gated("growthChallengeRatePercent", metrics.growthChallengeRatePercent),
  };

  // 팀 판정 verdicts — **크루 결과에서 파생**한다(같은 판정을 두 번 계산하지 않는다).
  //   not_applicable(미시작/공식휴식)은 팀 집계 대상이 아니므로 제외한다.
  const crewResults = buildCrewResults({ inputs, organization, week, criterionPointA, pointsByUser });
  // ── 크루 표 base row + 결과 overlay 결합 ──────────────────────────────────
  //   base(크루명·학적·클래스·팀·파트·품계)는 예비 전에도 보여야 하므로 항상 채운다.
  //   overlay(등수·포인트·완료율·성장률·누적)는 여기서 계산해 **같은 행**에 얹는다(행 재생성 없음).
  // week-effective 위치(팀·파트·클래스) — 조직 전체 배치 1회. 기존 공통 resolver 그대로 사용.
  //   ⚠ 크루 행과 팀 집계가 **같은 이 결과**를 쓴다(팀 집계가 현재 멤버십을 따로 읽지 않는다).
  const positions = await resolvePositionAtBatch({
    userIds: crewResults.map((c) => c.userId),
    targetWeekStart: week.start_date,
    organization,
  });
  // 품계 계산 실패 행(정상 null 인 not-eligible 은 제외). 공표 게이트의 입력.
  let gradeResolutionFailures: Array<{
    userId: string;
    displayName: string | null;
    reason: string;
  }> = [];
  {
    const ids = crewResults.map((c) => c.userId);
    const showcase = await loadCrewShowcaseInputs({
      organization,
      userIds: ids,
      weekStartDate: week.start_date,
      weekId,
      isoYear: week.iso_year,
      isoWeek: week.iso_week,
      // ⚠ 클래스·팀·파트는 **한 번의 resolver 호출 결과**에서 함께 가져온다.
      //   (override ≤W 최신 → UPH(W) → 당시 멤버십). 팀만 history·파트만 현재 같은 혼입을 막는다.
      positionByUser: new Map(
        [...positions.entries()].map(([uid, r]) => [
          uid,
          { classLabel: r.classLabel, teamName: r.rawTeam, partName: r.rawPart },
        ]),
      ),
      displayByUser: new Map(
        crewResults.map((c) => [
          c.userId,
          { displayName: c.crewDisplayName, crewCode: c.crewCode },
        ]),
      ),
      forceRefreshGrades: opts.forceRefreshGrades === true,
    });
    // 품계 계산 실패분 — 여기서 **모으기만** 하고 예비 검수는 막지 않는다(화면은 계속 떠야 한다).
    //   실제 차단은 publishCrewWeekResult 가 저장 시작 전에 수행한다.
    gradeResolutionFailures = collectGradeResolutionFailures(showcase.base);
    const ranks = computeRanks(
      crewResults.map((c) => ({
        userId: c.userId,
        pointA: showcase.points.get(c.userId)?.a ?? null,
      })),
    );
    for (const c of crewResults) {
      const b = showcase.base.get(c.userId);
      const ar = showcase.actRates.get(c.userId) ?? null;
      const pt = showcase.points.get(c.userId) ?? null;
      c.schoolName = b?.schoolName ?? null;
      c.majorName = b?.majorName ?? null;
      c.grade = b?.grade ?? null;
      c.gradeLabel = b?.gradeLabel ?? null;
      // 팀·파트·클래스를 같은 resolver 산출로 덮어쓴다(시점 통일).
      //   ⚠ resolver 가 EMPTY(rawTeam=null)를 준 경우 base row 의 현재 프로필값(234행 placeholder)
      //     으로 되돌아가면 안 된다 — resolver 가 일부러 비운 값이 "현재 소속"으로 되살아나
      //     그대로 공표 저장(cluster4_week_finalize_run_crew_results)까지 흘러가는 사고였다
      //     (2026-08-07 발견). resolver 결과가 SoT — null 이면 null 로 저장한다.
      const pos = positions.get(c.userId) ?? null;
      c.classLabel = pos?.classLabel ?? null;
      c.teamName = pos?.rawTeam ?? null;
      c.partName = pos?.rawPart ?? null;
      c.rank = ranks.get(c.userId) ?? null;
      c.earnedPointA = pt?.a ?? c.earnedPointA;
      c.pointB = pt?.b ?? null;
      c.pointC = pt?.c ?? null;
      c.actCompletionRatePercent = ar?.ratePercent ?? null;
      c.actTotalCount = ar?.total ?? null;
      c.actSuccessCount = ar?.success ?? null;
      // 주차 성장률·누적 성장성공 = weekly-cards snapshot(고객 앱과 동일 SoT). 없으면 null 유지.
      const gr = showcase.growth.get(c.userId) ?? null;
      c.weeklyGrowthRatePercent = gr?.weeklyGrowthRatePercent ?? null;
      c.cumulativeSuccessWeeks = gr?.cumulativeSuccessWeeks ?? null;
    }
    // 표시 정렬 = 등수 → 품계 → 성장률 desc → 이름 ko-KR → userId (고객 앱과 동일 키).
    const sorted = sortShowcaseRows(
      crewResults.map((c) => ({
        userId: c.userId,
        crewDisplayName: c.crewDisplayName,
        rank: c.rank,
        grade: c.grade,
        weeklyGrowthRatePercent: c.weeklyGrowthRatePercent,
      })),
    );
    const order = new Map(sorted.map((r, i) => [r.userId, i]));
    crewResults.sort((a, b2) => (order.get(a.userId) ?? 0) - (order.get(b2.userId) ?? 0));
  }

  const verdicts = new Map<string, TeamVerdict>();
  const seasonRestUserIds = new Set<string>();
  for (const c of crewResults) {
    if (c.result === "not_applicable") continue;
    if (c.result === "success") verdicts.set(c.userId, "success");
    else if (c.result === "failure") verdicts.set(c.userId, "fail");
    else if (c.result === "rest") {
      verdicts.set(c.userId, "rest");
      if (c.isSeasonRest) seasonRestUserIds.add(c.userId);
    }
  }
  // 공식 휴식 주차는 팀 대전이 없다 → 빈 배열(가짜 0 팀 행 생성 금지).
  //   ⚠ teamResults 는 **실제 팀(카탈로그 매칭)만** 담는다. '미배정' 가상 버킷은 projection 이
  //     분리해 주므로 여기서 다시 필터하지 않는다. 그 크루들은 crewResults·크루 종합 지표에 그대로 남는다.
  const teamProjection =
    week.is_official_rest === true || verdicts.size === 0
      ? { teams: [], unmatched: [] }
      : buildCrewWeekTeamResults({
          ctx: await loadCrewWeekTeamContext({
            organization,
            halfKey: week.season_key ? seasonKeyToHalfKey(week.season_key) : null,
            weekStartDate: week.start_date,
          }),
          // 소속은 **크루 행에 최종 표시된 값 그대로** 넘긴다(rawTeam ?? 프로필 폴백까지 동일).
          //   → 크루 표의 팀별 인원 합 == 팀 표 totalCrew 합 이 구조적으로 보장된다.
          positions: new Map(
            crewResults.map((c) => [
              c.userId,
              {
                teamName: c.teamName,
                partName: c.partName,
                positionCode: positions.get(c.userId)?.positionCode ?? null,
              },
            ]),
          ),
          verdicts,
          seasonRestUserIds,
        });
  const teamResults = teamProjection.teams;
  if (teamProjection.unmatched.length > 0) {
    // 진단용 — 팀 카탈로그에 매칭되지 않은 크루가 있다는 사실 자체는 남긴다(집계에는 미반영).
    console.info(
      "[crew-week-publish] 팀 카탈로그 미매칭 버킷 제외",
      teamProjection.unmatched.map((t) => `${t.teamName}:${t.totalCrew}명`).join(", "),
    );
  }

  return {
    kind: "preview",
    published: false,
    organizationSlug: organization,
    weekId,
    criterionPointA,
    metricsReadiness: readiness,
    ...gatedMetrics,
    crewResults,
    teamResults,
    calculatedAt: new Date().toISOString(),
    calculationVersion: CREW_METRICS_CALC_VERSION,
    sourceActivityDate: opts.today ?? getCurrentActivityDateIso(),
    // 예비 화면에서도 "이 상태로는 공표할 수 없다"를 미리 보여주기 위한 진단 필드.
    //   빈 배열 = 공표 가능(품계 기준). not-eligible 은 여기 들어오지 않는다.
    gradeResolutionFailures,
  };
}

export class CrewWeekPublishError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * 구조화된 실패 상세(선택). 라우트가 응답 body 에 그대로 실어 화면이 "누가·왜" 를
     * 열거할 수 있게 한다. 내부 식별자/스택은 담지 않는다.
     */
    public details?: CrewWeekPublishErrorDetails,
  ) {
    super(message);
    this.name = "CrewWeekPublishError";
  }
}

export type CrewWeekPublishErrorDetails = {
  code: "GRADE_RESOLUTION_FAILED";
  /** snapshot 이 만들어지지 않았다는 사실을 응답에서 못 박는다. */
  snapshotCreated: false;
  failedCount: number;
  failures: Array<{ userId: string; displayName: string | null; reason: string }>;
};

// ── 활성 run 조회 ───────────────────────────────────────────────────────────
type RunRow = {
  id: string;
  week_id: string;
  organization_slug: string | null;
  scope: string | null;
  actor_id: string | null;
  created_at: string;
  reverted_at: string | null;
  snapshot_captured: boolean | null;
  criterion_point_a: number | null;
  member_count: number | null;
  season_rest_count: number | null;
  personal_rest_count: number | null;
  growth_challenge_count: number | null;
  growth_success_count: number | null;
  growth_failure_count: number | null;
  growth_success_rate_percent: number | null;
  growth_challenge_rate_percent: number | null;
  calculated_at: string | null;
  calculation_version: number | null;
  source_activity_date: string | null;
};

const RUN_SELECT =
  "id,week_id,organization_slug,scope,actor_id,created_at,reverted_at,snapshot_captured," +
  "criterion_point_a,member_count,season_rest_count,personal_rest_count,growth_challenge_count," +
  "growth_success_count,growth_failure_count,growth_success_rate_percent," +
  "growth_challenge_rate_percent,calculated_at,calculation_version,source_activity_date";

// ── uws 롤백 provenance ─────────────────────────────────────────────────────
// finalizeWeekUws 가 run 행에 남기는 "무엇을 만들고 무엇을 어떤 값에서 바꿨는가". 공표 취소가
//   이 값으로 uws 를 정확히 되돌린다. 재공표는 활성 run 을 교체하므로 **이어붙여야** 한다.
type RunProvenance = {
  created_uws_ids: string[];
  updated_uws: Array<{ id: string; prev_status: string }>;
};
const EMPTY_PROVENANCE: RunProvenance = { created_uws_ids: [], updated_uws: [] };

async function loadRunProvenance(runId: string): Promise<RunProvenance> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("created_uws_ids,updated_uws")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return EMPTY_PROVENANCE;
  const row = data as Partial<RunProvenance>;
  return {
    created_uws_ids: row.created_uws_ids ?? [],
    updated_uws: row.updated_uws ?? [],
  };
}

// 병합 규칙: created 는 합집합(이미 지워진 id 는 롤백 시 no-op).
//   updated 는 **이전 실행의 prev_status 가 우선**이다 — 되돌릴 목표는 "최초 확정 직전 값"이므로
//   같은 uws 를 두 번 바꿨다면 더 오래된 prev_status 를 남겨야 원상복구가 된다.
function mergeProvenance(older: RunProvenance, newer: RunProvenance): RunProvenance {
  const created = [...new Set([...older.created_uws_ids, ...newer.created_uws_ids])];
  const byId = new Map<string, { id: string; prev_status: string }>();
  for (const u of newer.updated_uws) byId.set(u.id, u);
  for (const u of older.updated_uws) byId.set(u.id, u); // older wins
  return { created_uws_ids: created, updated_uws: [...byId.values()] };
}

export async function loadActiveRun(
  weekId: string,
  organization: OrganizationSlug,
  scope: OrgResultScope,
): Promise<RunRow | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select(RUN_SELECT)
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .eq("scope", toFinalizeRunScope(scope))
    .is("reverted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[crew-week-publish] 활성 run 조회 실패", error.message);
    return null;
  }
  return (data as RunRow | null) ?? null;
}

/** 공표 결과 조회 — **활성 run snapshot 만** 읽는다. live 폴백 없음. */
export async function loadPublishedCrewWeekResult(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
}): Promise<CrewWeekPublishedResultDto | null> {
  const run = await loadActiveRun(opts.weekId, opts.organization, opts.scope);
  if (!run) return null;

  // legacy run(2026-07-22 이전) = snapshot 미보유. 지표를 live 로 채우지 않는다(조용한 오염 방지).
  if (run.snapshot_captured !== true) {
    return {
      kind: "published",
      published: true,
      snapshotUnavailable: true,
      runId: run.id,
      publishedAt: run.created_at,
      publishedBy: run.actor_id,
      organizationSlug: opts.organization,
      weekId: opts.weekId,
      criterionPointA: null,
      metricsReadiness: {
        memberCount: "unavailable", seasonRestCount: "unavailable",
        personalRestCount: "unavailable", growthChallengeCount: "unavailable",
        growthSuccessCount: "unavailable", growthFailureCount: "unavailable",
        growthSuccessRatePercent: "unavailable", growthChallengeRatePercent: "unavailable",
      },
      memberCount: null,
      seasonRestCount: null,
      personalRestCount: null,
      growthChallengeCount: null,
      growthSuccessCount: null,
      growthFailureCount: null,
      growthSuccessRatePercent: null,
      growthChallengeRatePercent: null,
      crewResults: [],
      teamResults: [],
      calculatedAt: run.created_at,
      calculationVersion: 0,
      sourceActivityDate: run.source_activity_date ?? "",
    };
  }

  const { data: crewRows } = await supabaseAdmin
    .from("cluster4_week_finalize_run_crew_results")
    .select(
      "user_id,crew_display_name,crew_code,organization_slug,team_name,part_name," +
        "is_season_rest,is_personal_rest,is_growth_challenge,result,uws_status," +
        "criterion_point_a,earned_point_a,reason_code," +
        "school_name,major_name,class_label,grade,grade_label," +
        "rank,point_b,point_c,act_completion_rate_percent,act_total_count," +
        "act_success_count,weekly_growth_rate_percent,cumulative_success_weeks",
    )
    .eq("run_id", run.id)
    .order("crew_display_name", { ascending: true });

  const crewResults: CrewWeekCrewResultDto[] = (
    (crewRows ?? []) as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    userId: r.user_id as string,
    crewDisplayName: (r.crew_display_name as string | null) ?? null,
    crewCode: (r.crew_code as string | null) ?? null,
    organizationSlug: r.organization_slug as OrganizationSlug,
    teamName: (r.team_name as string | null) ?? null,
    partName: (r.part_name as string | null) ?? null,
    isSeasonRest: r.is_season_rest === true,
    isPersonalRest: r.is_personal_rest === true,
    isGrowthChallenge: r.is_growth_challenge === true,
    result: r.result as CrewWeekCrewResultKind,
    uwsStatus: (r.uws_status as string | null) ?? null,
    criterionPointA: (r.criterion_point_a as number | null) ?? null,
    earnedPointA: (r.earned_point_a as number | null) ?? null,
    reasonCode: r.reason_code as string,
    // 공표 후에는 **snapshot 값만** 쓴다(현재 프로필/live 혼입 금지).
    schoolName: (r.school_name as string | null) ?? null,
    majorName: (r.major_name as string | null) ?? null,
    classLabel: (r.class_label as string | null) ?? null,
    grade: (r.grade as number | null) ?? null,
    gradeLabel: (r.grade_label as string | null) ?? null,
    rank: (r.rank as number | null) ?? null,
    pointB: (r.point_b as number | null) ?? null,
    pointC: (r.point_c as number | null) ?? null,
    actCompletionRatePercent: (r.act_completion_rate_percent as number | null) ?? null,
    actTotalCount: (r.act_total_count as number | null) ?? null,
    actSuccessCount: (r.act_success_count as number | null) ?? null,
    weeklyGrowthRatePercent: (r.weekly_growth_rate_percent as number | null) ?? null,
    cumulativeSuccessWeeks: (r.cumulative_success_weeks as number | null) ?? null,
  }));

  // 팀 결과 snapshot — 공표 당시 값. live 재계산하지 않는다.
  const { data: teamRows } = await supabaseAdmin
    .from("cluster4_week_finalize_run_team_results")
    .select(
      "team_id,team_name,team_snapshot_key,display_order,battle_result,leader_user_id," +
        "leader_display_name,leader_school_name,leader_major_name,part_count,total_crew," +
        "advanced_crew,regular_crew,challenge_crew,rest_crew,season_rest_crew,personal_rest_crew," +
        "success_crew,fail_crew,match_count,win_count,loss_count,win_rate_percent",
    )
    .eq("run_id", run.id)
    .order("display_order", { ascending: true });

  const teamResults: CrewWeekTeamResultDto[] = (
    (teamRows ?? []) as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    teamId: (r.team_id as string | null) ?? null,
    teamName: r.team_name as string,
    teamSnapshotKey: r.team_snapshot_key as string,
    displayOrder: (r.display_order as number | null) ?? 9999,
    battleResult: r.battle_result as CrewWeekTeamResultDto["battleResult"],
    leader: {
      userId: (r.leader_user_id as string | null) ?? null,
      displayName: (r.leader_display_name as string | null) ?? null,
      schoolName: (r.leader_school_name as string | null) ?? null,
      majorName: (r.leader_major_name as string | null) ?? null,
    },
    partCount: (r.part_count as number | null) ?? 0,
    totalCrew: (r.total_crew as number | null) ?? 0,
    advancedCrew: (r.advanced_crew as number | null) ?? 0,
    regularCrew: (r.regular_crew as number | null) ?? 0,
    challengeCrew: (r.challenge_crew as number | null) ?? 0,
    restCrew: (r.rest_crew as number | null) ?? 0,
    seasonRestCrew: (r.season_rest_crew as number | null) ?? 0,
    personalRestCrew: (r.personal_rest_crew as number | null) ?? 0,
    successCrew: (r.success_crew as number | null) ?? 0,
    failCrew: (r.fail_crew as number | null) ?? 0,
    matchCount: (r.match_count as number | null) ?? 0,
    winCount: (r.win_count as number | null) ?? 0,
    lossCount: (r.loss_count as number | null) ?? 0,
    winRatePercent: (r.win_rate_percent as number | null) ?? 0,
  }));

  return {
    kind: "published",
    published: true,
    snapshotUnavailable: false,
    teamResults,
    runId: run.id,
    publishedAt: run.created_at,
    publishedBy: run.actor_id,
    organizationSlug: opts.organization,
    weekId: opts.weekId,
    criterionPointA: run.criterion_point_a,
    // 공표 snapshot 은 저장된 값이 곧 확정값 — 값이 있으면 ready, NULL 이면 unavailable.
    metricsReadiness: {
      memberCount: run.member_count == null ? "unavailable" : "ready",
      seasonRestCount: run.season_rest_count == null ? "unavailable" : "ready",
      personalRestCount: run.personal_rest_count == null ? "unavailable" : "ready",
      growthChallengeCount: run.growth_challenge_count == null ? "unavailable" : "ready",
      growthSuccessCount: run.growth_success_count == null ? "unavailable" : "ready",
      growthFailureCount: run.growth_failure_count == null ? "unavailable" : "ready",
      growthSuccessRatePercent: run.growth_success_rate_percent == null ? "unavailable" : "ready",
      growthChallengeRatePercent: run.growth_challenge_rate_percent == null ? "unavailable" : "ready",
    },
    memberCount: run.member_count,
    seasonRestCount: run.season_rest_count,
    personalRestCount: run.personal_rest_count,
    growthChallengeCount: run.growth_challenge_count,
    growthSuccessCount: run.growth_success_count,
    growthFailureCount: run.growth_failure_count,
    growthSuccessRatePercent: run.growth_success_rate_percent,
    growthChallengeRatePercent: run.growth_challenge_rate_percent,
    crewResults,
    calculatedAt: run.calculated_at ?? run.created_at,
    calculationVersion: run.calculation_version ?? 0,
    sourceActivityDate: run.source_activity_date ?? "",
  };
}

// ── 공표 상태(진입 즉시 1회) ────────────────────────────────────────────────
// 상세 화면의 **버튼/표시 분기를 서버 사실로 확정**하기 위한 요약. 클라이언트가 상태를 추측하지
//   않게 한다. 새 저장소가 아니라 기존 두 SoT(조직 검수 상태 · finalize run)를 한 번에 읽어 합친 것.
//
// ⚠ 가장 중요한 구분 — "검수 완료(published)인데 활성 공표 snapshot 이 없다"(legacy 검수 완료 주차)를
//   **일반 집계 중과 절대 섞지 않는다.** live 결과로 조용히 폴백하지도 않는다(값이 달라진다).
export type CrewWeekPublicationState = {
  /** 조직별 검수 상태 SoT(폴백 포함). */
  orgStatus: WeekOrgResultStatus;
  /** organization = 조직별 행 존재 · legacy = 행 없음(weeks.result_reviewed_at 폴백). */
  orgStatusSource: "organization" | "legacy";
  /** 활성 finalize run 이 있는가(snapshot 유무 무관) — 공표 취소 대상 존재 여부. */
  hasActiveRun: boolean;
  /** 활성 run 이 snapshot 을 보유 = 결과를 표시할 수 있다. */
  hasActiveSnapshot: boolean;
  /**
   * org 상태는 published 인데 표시 가능한 공표 snapshot 이 없다 = **기존 방식으로 검수 완료된 주차**.
   *   (run 자체가 없거나, 있어도 snapshot_captured=false 인 legacy run)
   *   화면은 완료 상태를 유지한 채 "결과를 표시할 수 없음"을 명시해야 한다.
   */
  legacyCompletedWithoutSnapshot: boolean;
  activeRunId: string | null;
  /** 주차가 실제로 끝났는가 — 진행 중 주차는 공표 불가(서버도 422). */
  weekEnded: boolean;
};

export async function loadCrewWeekPublicationState(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
  today?: string;
}): Promise<CrewWeekPublicationState> {
  const { organization, weekId, scope } = opts;
  const [week, stateMap, run] = await Promise.all([
    loadWeekMeta(weekId),
    loadWeekOrgResultStates([weekId], organization, scope),
    loadActiveRun(weekId, organization, scope),
  ]);
  const state = resolveWeekOrgResultState(
    stateMap.get(weekId),
    week?.start_date ?? "",
    week?.result_reviewed_at != null,
  );
  const hasActiveRun = run != null;
  const hasActiveSnapshot = run?.snapshot_captured === true;
  const activityDate = opts.today ?? getCurrentActivityDateIso();
  return {
    orgStatus: state.status,
    orgStatusSource: state.source,
    hasActiveRun,
    hasActiveSnapshot,
    legacyCompletedWithoutSnapshot: state.status === "published" && !hasActiveSnapshot,
    activeRunId: run?.id ?? null,
    weekEnded: week != null && activityDate > week.end_date,
  };
}

// ── [4] 공표 = 정식 확정 트랜잭션 흐름 ──────────────────────────────────────
//
// 2026-07-27 통합: 공표가 종전 `/weeks/*` [주차 검수] 의 확정 작업까지 **함께** 수행한다.
//   실행 순서는 데이터 의존성으로 정해진다(바꾸면 결과가 틀어진다):
//
//   [A] 사전 게이트(저장 0)  — 품계 계산 실패 확인. 확정 전에 막아야 되돌릴 일이 안 생긴다.
//   [B] 이전 활성 run 닫기   — partial unique index(week_id, org, scope) WHERE reverted_at IS NULL.
//                              ⚠ [C] 보다 먼저 — finalizeWeekUws 도 같은 테이블에 run 을 만들기 때문에
//                                이전 run 이 열려 있으면 uws provenance 기록이 인덱스 충돌로 유실된다.
//   [C] finalizeWeekResultCore — uws 코호트 확정 → weeks.result_published_at → 라인 A/B 원장 정합
//                              → 고객 앱 weekly-card snapshot 재계산 → user_growth_stats → result_reviewed_at.
//   [D] 확정 후 재계산       — computeCrewWeekPreview 를 **[C] 다음에** 돌린다. 이때 buildCrewResults 가
//                              확정된 user_week_statuses 를 읽으므로 활동 0건 크루가 uws_missing 으로
//                              굳지 않고, 고객 앱 snapshot 과 어드민 snapshot 이 같은 확정 결과를 본다.
//   [E] 불변식 검증 → [F] run 에 snapshot 기록 → [G] crew/team rows.
//
//   ⚠ run 행은 **1건**이다. [C] 의 finalizeWeekUws 가 만든 run(uws provenance 보유)에 snapshot 을
//     UPDATE 로 얹는다 — 새 행을 또 넣으면 활성 run 이 둘이 되어 인덱스가 막고, uws 롤백 근거도 갈린다.
//     uws 변경이 0건이라 run 이 없으면(runId=null) 종전처럼 INSERT 한다.
export async function publishCrewWeekResult(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
  actorId: string | null;
  today?: string;
}): Promise<CrewWeekPublishedResultDto> {
  const { organization, weekId, scope, actorId } = opts;

  const week = await loadWeekMeta(weekId);
  if (!week) throw new CrewWeekPublishError(404, "주차를 찾을 수 없습니다.");

  // 진행 중 주차 공표 금지 — finalizeWeekResultCore 의 current_or_future_week 가드와 동일 정책.
  const activityDate = opts.today ?? getCurrentActivityDateIso();
  if (activityDate <= week.end_date) {
    throw new CrewWeekPublishError(
      422,
      "아직 진행 중인 주차는 공표할 수 없습니다. 주차가 종료된 후 공표해주세요.",
    );
  }

  // ── [A] 사전 게이트 — 저장 0. 품계 계산 실패는 **확정을 시작하기 전에** 차단한다.
  //   실패한 null 이 snapshot 에 굳으면 되돌릴 방법이 없다(공표 후 조회는 snapshot 직독).
  //   ⚠ 정상 제외(not-eligible: 시즌 휴식·산정 주차 없음)는 차단 대상이 아니다 — collectGrade-
  //     ResolutionFailures 가 status='failed' 만 모은다.
  {
    const pre = await computeCrewWeekPreview({
      organization,
      weekId,
      scope,
      today: opts.today,
    });
    if (pre.gradeResolutionFailures.length > 0) {
      const f = pre.gradeResolutionFailures;
      const names = f
        .slice(0, 5)
        .map((x) => x.displayName ?? x.userId)
        .join(", ");
      throw new CrewWeekPublishError(
        409,
        `품계 계산에 실패한 크루가 ${f.length}명 있어 공표를 중단했습니다(저장 없음). ` +
          `${names}${f.length > 5 ? ` 외 ${f.length - 5}명` : ""}. 잠시 후 다시 시도해주세요.`,
        {
          code: "GRADE_RESOLUTION_FAILED",
          snapshotCreated: false,
          failedCount: f.length,
          failures: f,
        },
      );
    }
  }

  // ── [B] 이전 활성 run 을 닫는다(unique index 회피 + uws provenance 기록 자리 확보).
  //   ⚠ 닫기 전에 uws provenance 를 읽어 둔다. 재공표 시 이번 실행의 uws 변경분이 0건이어도
  //     **이전 실행이 만든 uws 는 그대로 남아 있으므로**, 되돌릴 근거를 새 run 으로 이어붙여야 한다
  //     (안 그러면 공표 취소가 그 uws 를 못 지운다 — 실측 2026-07-27: 재공표 후 34행이 안 지워짐).
  const prev = await loadActiveRun(weekId, organization, scope);
  const prevProvenance = prev ? await loadRunProvenance(prev.id) : EMPTY_PROVENANCE;
  const nowIso = new Date().toISOString();
  if (prev) {
    const { error } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .update({ reverted_at: nowIso })
      .eq("id", prev.id)
      .is("reverted_at", null);
    if (error) throw new CrewWeekPublishError(500, `이전 공표 종료 실패: ${error.message}`);
  }

  // ── [C] 확정 — 종전 [주차 검수] 의 전 단계를 공통 서비스로 수행한다.
  //   차단(422: 오픈 확인 미완료·적립 미완료·평가 미입력·진행 중 주차)이면 여기서 끝난다.
  //   그 경우 [B] 에서 닫은 이전 run 을 되살려 화면이 종전 공표본을 계속 보게 한다(무손실).
  let core: WeekResultFinalizeResult;
  try {
    core = await finalizeWeekResultCore(weekId, actorId, {
      // OrgResultScope('operating'|'test') → StateScope('operating'|'qa') 어휘 변환.
      //   ⚠ 문자열 직접 비교 금지 — toFinalizeRunScope 단일 경로.
      scope: toFinalizeRunScope(scope),
      organization,
    });
  } catch (e) {
    if (prev) {
      await supabaseAdmin
        .from("cluster4_week_finalize_runs")
        .update({ reverted_at: null })
        .eq("id", prev.id);
    }
    if (e instanceof WeekResultFinalizeError) throw new CrewWeekPublishError(e.status, e.message);
    throw e;
  }

  // ── [D] 확정된 원천으로 다시 계산한다.
  // ⚠ 클라이언트가 보낸 숫자를 신뢰하지 않는다 — 서버가 최신 원천으로 다시 계산한다.
  //   품계는 forceRefreshGrades 로 TTL 캐시를 건너뛴다 — 30초 전 계산값을 snapshot 에 확정하지 않는다.
  const preview = await computeCrewWeekPreview({
    organization,
    weekId,
    scope,
    today: opts.today,
    forceRefreshGrades: true,
  });

  // ── [E] 불변식 위반은 snapshot 을 쓰기 전에 차단한다(부분 저장 금지 · DB CHECK 와 같은 규칙).
  //   ⚠ 이 시점엔 [C] 확정이 이미 끝나 있다 — 주차는 정상 확정 상태이고 어드민 snapshot 만 미생성이다
  //     (= 기존에도 존재하던 legacyCompletedWithoutSnapshot 상태). 재실행하면 그대로 수렴한다.
  const actViolation = assertActRateInvariants(preview.crewResults);
  if (actViolation) {
    throw new CrewWeekPublishError(
      422,
      `활동 완료율 정합성 오류로 공표를 중단했습니다: ${actViolation}`,
    );
  }
  const teamViolation = assertTeamInvariants(preview.teamResults);
  if (teamViolation) {
    throw new CrewWeekPublishError(
      422,
      `팀 결과 정합성 오류로 공표를 중단했습니다: ${teamViolation}`,
    );
  }

  // ── [F] run 에 결과 snapshot 기록.
  //   [C] 가 uws provenance run 을 만들었으면 **그 행에 UPDATE**(활성 run 1건 유지 · 롤백 근거 보존),
  //   uws 변경이 0건이라 run 이 없으면 INSERT.
  const snapshotFields = {
    snapshot_captured: true,
    criterion_point_a: preview.criterionPointA,
    member_count: preview.memberCount,
    season_rest_count: preview.seasonRestCount,
    personal_rest_count: preview.personalRestCount,
    growth_challenge_count: preview.growthChallengeCount,
    growth_success_count: preview.growthSuccessCount,
    growth_failure_count: preview.growthFailureCount,
    growth_success_rate_percent: preview.growthSuccessRatePercent,
    growth_challenge_rate_percent: preview.growthChallengeRatePercent,
    calculated_at: preview.calculatedAt,
    calculation_version: preview.calculationVersion,
    source_activity_date: preview.sourceActivityDate,
    // 기존 카운트 컬럼도 함께 채운다(레거시 소비자 호환).
    cohort_count: preview.memberCount ?? 0,
    success_count: preview.growthSuccessCount ?? 0,
    fail_count: preview.growthFailureCount ?? 0,
    rest_count: (preview.seasonRestCount ?? 0) + (preview.personalRestCount ?? 0),
  };

  let runId: string;
  const coreRunId = core.uwsFinalize?.runId ?? null;
  if (coreRunId) {
    // [C] 가 만든 run 에 snapshot 을 얹는다. provenance = 이전 실행분 ∪ 이번 실행분.
    const merged = mergeProvenance(prevProvenance, await loadRunProvenance(coreRunId));
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .update({ ...snapshotFields, ...merged, actor_id: actorId })
      .eq("id", coreRunId)
      .is("reverted_at", null)
      .select("id")
      .single();
    if (updErr || !updated) {
      throw new CrewWeekPublishError(
        500,
        `공표 저장 실패: ${updErr?.message ?? "확정 run 을 찾을 수 없습니다."}`,
      );
    }
    runId = (updated as { id: string }).id;
  } else {
    // uws 변경 0건(재공표 등) — 새 run 을 만들고 이전 provenance 를 그대로 이어받는다.
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .insert({
        week_id: weekId,
        organization_slug: organization,
        scope: toFinalizeRunScope(scope),
        actor_id: actorId,
        ...snapshotFields,
        skipped_count: 0,
        ...prevProvenance,
      })
      .select("id,created_at")
      .single();
    if (insErr || !inserted) {
      throw new CrewWeekPublishError(500, `공표 저장 실패: ${insErr?.message ?? "unknown"}`);
    }
    runId = (inserted as { id: string }).id;
  }

  // 재시도로 같은 run 에 다시 쓰는 경우를 대비해 이전 결과 행을 비운다(UNIQUE(run_id,user_id) 충돌 방지).
  //   신규 run 이면 0행 삭제(no-op).
  await supabaseAdmin.from("cluster4_week_finalize_run_crew_results").delete().eq("run_id", runId);
  await supabaseAdmin.from("cluster4_week_finalize_run_team_results").delete().eq("run_id", runId);

  // 결과 행 저장 중 실패 시 — snapshot 만 무효화한다(run 은 uws provenance 보유라 보존).
  //   결과: 활성 run 은 있으나 snapshot_captured=false = 기존 legacyCompletedWithoutSnapshot 상태.
  //   화면이 이미 다루는 상태이며, 공표를 재실행하면 그대로 수렴한다.
  const abortSnapshot = async () => {
    await supabaseAdmin.from("cluster4_week_finalize_run_crew_results").delete().eq("run_id", runId);
    await supabaseAdmin.from("cluster4_week_finalize_run_team_results").delete().eq("run_id", runId);
    const { error } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .update({ snapshot_captured: false })
      .eq("id", runId);
    if (error) console.warn("[crew-week-publish] snapshot 무효화 실패", error.message);
  };

  // ── [G] 크루별 결과 저장.
  if (preview.crewResults.length > 0) {
    const rows = preview.crewResults.map((c) => ({
      run_id: runId,
      user_id: c.userId,
      crew_display_name: c.crewDisplayName,
      crew_code: c.crewCode,
      organization_slug: c.organizationSlug,
      team_name: c.teamName,
      part_name: c.partName,
      is_season_rest: c.isSeasonRest,
      is_personal_rest: c.isPersonalRest,
      is_growth_challenge: c.isGrowthChallenge,
      result: c.result,
      uws_status: c.uwsStatus,
      criterion_point_a: c.criterionPointA,
      earned_point_a: c.earnedPointA,
      reason_code: c.reasonCode,
      school_name: c.schoolName,
      major_name: c.majorName,
      class_label: c.classLabel,
      grade: c.grade,
      grade_label: c.gradeLabel,
      rank: c.rank,
      point_b: c.pointB,
      point_c: c.pointC,
      act_completion_rate_percent: c.actCompletionRatePercent,
      act_total_count: c.actTotalCount,
      act_success_count: c.actSuccessCount,
      weekly_growth_rate_percent: c.weeklyGrowthRatePercent,
      cumulative_success_weeks: c.cumulativeSuccessWeeks,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("cluster4_week_finalize_run_crew_results")
        .insert(rows.slice(i, i + 500));
      if (error) {
        // 부분 반영 금지 — snapshot 을 무효화한다. ⚠ run 을 DELETE 하지 않는다:
        //   이 run 은 [C] 확정의 uws provenance(created_uws_ids/updated_uws)를 들고 있어
        //   지우면 공표 취소가 uws 를 되돌릴 근거를 잃는다. 이전 run 도 되살리지 않는다
        //   (주차는 이미 확정됐으므로 옛 snapshot 을 되살리면 사실과 어긋난다).
        await abortSnapshot();
        throw new CrewWeekPublishError(500, `크루 결과 저장 실패: ${error.message}`);
      }
    }
  }

  // 3-2) 팀별 결과 저장 — crew 와 **같은 run** 에 담긴다.
  if (preview.teamResults.length > 0) {
    const teamRows = preview.teamResults.map((t) => ({
      run_id: runId,
      team_id: t.teamId,
      team_name: t.teamName,
      team_snapshot_key: t.teamSnapshotKey,
      display_order: t.displayOrder,
      battle_result: t.battleResult,
      leader_user_id: t.leader.userId,
      leader_display_name: t.leader.displayName,
      leader_school_name: t.leader.schoolName,
      leader_major_name: t.leader.majorName,
      part_count: t.partCount,
      total_crew: t.totalCrew,
      advanced_crew: t.advancedCrew,
      regular_crew: t.regularCrew,
      challenge_crew: t.challengeCrew,
      rest_crew: t.restCrew,
      season_rest_crew: t.seasonRestCrew,
      personal_rest_crew: t.personalRestCrew,
      success_crew: t.successCrew,
      fail_crew: t.failCrew,
      match_count: t.matchCount,
      win_count: t.winCount,
      loss_count: t.lossCount,
      win_rate_percent: t.winRatePercent,
    }));
    const { error } = await supabaseAdmin
      .from("cluster4_week_finalize_run_team_results")
      .insert(teamRows);
    if (error) {
      // 부분 반영 금지 — snapshot 무효화(위와 동일 이유로 run DELETE·prev 복구 금지).
      await abortSnapshot();
      throw new CrewWeekPublishError(500, `팀 결과 저장 실패: ${error.message}`);
    }
  }

  // 4) 조직 검수 상태 전환 — 여기서만 published 가 된다.
  await setWeekOrgResultStatus(weekId, organization, scope, "published", actorId);

  const result = await loadPublishedCrewWeekResult({ organization, weekId, scope });
  if (!result) throw new CrewWeekPublishError(500, "공표 후 결과 조회에 실패했습니다.");
  return result;
}

// ── [4] 공표 취소 = 정식 확정 취소 흐름 ─────────────────────────────────────
//
// 2026-07-27 통합: 종전 `/weeks/*` [실행 취소](DELETE /review)가 되돌리던 범위를 그대로 되돌린다.
//   되돌리는 것: user_week_statuses(생성분 DELETE·갱신분 prev_status 복원) · weeks.result_published_at
//   · weeks.result_reviewed_at · 고객 앱 weekly-card snapshot(집계 중 복귀) · user_growth_stats
//   · 어드민 공표 run/crew/team(reverted_at — 물리 DELETE 금지) · cluster4_week_org_result_states.
//
// ⚠ 실행 순서: revertWeekResultCore 를 **먼저** 부른다. 내부 revertWeekUws 가 "reverted_at IS NULL 인
//   최신 run" 을 provenance 로 삼기 때문에, run 을 먼저 닫으면 uws 를 되돌릴 근거를 잃는다.
//   (revertWeekUws 가 롤백 후 그 run 의 reverted_at 을 직접 찍는다 — 아래 3) 은 그러지 못한 경우의 보정.)
//
// ⚠ 포인트 원장: 새 정책을 만들지 않는다. 기존 rollback 로직 그대로이며, 라인 A/B 는 다음 확정 시
//   reconcileLineAwardsForWeek 가 성공/비성공 기준으로 재정합(회수 포함)한다.
export async function unpublishCrewWeekResult(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
  actorId: string | null;
}): Promise<{
  reverted: boolean;
  runId: string | null;
  weekRevert: WeekResultRevertResult | null;
}> {
  const { organization, weekId, scope, actorId } = opts;
  const run = await loadActiveRun(weekId, organization, scope);

  // 1) 확정 취소 — uws 역연산 + weeks 공표/검수 해제 + 고객 앱 snapshot·성장 통계 원복.
  //   공표된 적 없는(run 없음) 주차에도 실행한다 — 자동 sweep 등 다른 경로가 확정해 둔 상태를
  //   같은 화면에서 되돌릴 수 있어야 하고, 내부 단계가 전부 멱등(no-op)이라 안전하다.
  let weekRevert: WeekResultRevertResult | null = null;
  try {
    weekRevert = await revertWeekResultCore(
      weekId,
      toFinalizeRunScope(scope),
      actorId,
      organization,
    );
  } catch (e) {
    if (e instanceof WeekResultFinalizeError) throw new CrewWeekPublishError(e.status, e.message);
    throw e;
  }

  // 2) 어드민 공표 run 비활성화 — 물리 DELETE 금지(reverted_at 으로 감사 이력 보존).
  //   revertWeekUws 가 이미 찍었으면 .is(reverted_at, null) 가드로 0행(멱등).
  if (run) {
    const { error } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .update({ reverted_at: new Date().toISOString() })
      .eq("id", run.id)
      .is("reverted_at", null);
    if (error) throw new CrewWeekPublishError(500, `공표 취소 실패: ${error.message}`);
  }

  // 3) 검수 완료 → 집계 중 (core 도 시작 시 세팅하지만, 최종 상태를 여기서 확정한다).
  await setWeekOrgResultStatus(weekId, organization, scope, "aggregating", actorId);
  return {
    reverted: run != null || weekRevert?.reverted === true,
    runId: run?.id ?? null,
    weekRevert,
  };
}

/** 조직×주차 목록용 — 활성 snapshot run 을 벌크 조회한다(목록 N+1 방지). */
export async function loadActiveRunsByWeek(
  weekIds: string[],
  organization: OrganizationSlug,
  scope: OrgResultScope,
): Promise<Map<string, RunRow>> {
  const map = new Map<string, RunRow>();
  if (weekIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select(RUN_SELECT)
    .in("week_id", weekIds)
    .eq("organization_slug", organization)
    .eq("scope", toFinalizeRunScope(scope))
    .is("reverted_at", null);
  if (error) {
    console.warn("[crew-week-publish] 활성 run 벌크 조회 실패", error.message);
    return map;
  }
  for (const r of (data ?? []) as unknown as RunRow[]) map.set(r.week_id, r);
  return map;
}

/** 표시명 보조 — 조직 한글명(감사 로그용). */
export const publishOrgLabel = organizationLabelKo;
