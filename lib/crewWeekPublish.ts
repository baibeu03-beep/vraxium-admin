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
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { organizationLabelKo, type OrganizationSlug } from "@/lib/organizations";
import {
  setWeekOrgResultStatus,
  type OrgResultScope,
} from "@/lib/weekOrgResultState";
import {
  loadCrewWeeklyMetricsInputs,
  computeCrewWeeklyMetrics,
  CREW_METRICS_CALC_VERSION,
  type CrewWeeklyMetricsInputs,
} from "@/lib/crewWeeklyMetricsAggregation";
import type { CrewWeeklyMetrics } from "@/lib/crewWeeklyMetricsAggregation";

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
  calculatedAt: string;
  calculationVersion: number;
  sourceActivityDate: string;
};

/** 예비 결과 — 저장되지 않았음을 타입으로 못박는다. */
export type CrewWeekPreviewResultDto = CrewWeekResultPayload & {
  kind: "preview";
  published: false;
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
};

async function loadWeekMeta(weekId: string): Promise<WeekMeta | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,start_date,end_date,is_official_rest")
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

  return {
    kind: "preview",
    published: false,
    organizationSlug: organization,
    weekId,
    criterionPointA,
    metricsReadiness: readiness,
    ...gatedMetrics,
    crewResults: buildCrewResults({ inputs, organization, week, criterionPointA, pointsByUser }),
    calculatedAt: new Date().toISOString(),
    calculationVersion: CREW_METRICS_CALC_VERSION,
    sourceActivityDate: opts.today ?? getCurrentActivityDateIso(),
  };
}

export class CrewWeekPublishError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CrewWeekPublishError";
  }
}

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
        "criterion_point_a,earned_point_a,reason_code",
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
  }));

  return {
    kind: "published",
    published: true,
    snapshotUnavailable: false,
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

// ── [4] 공표 ────────────────────────────────────────────────────────────────
// 순서(중요): 새 run + crew rows 를 **먼저 완성**하고, 마지막에 이전 활성 run 을 닫는다.
//   partial unique index(week_id, org, scope) WHERE reverted_at IS NULL 때문에 동시에 두 활성 run 이
//   존재할 수 없으므로, 이전 run 을 먼저 닫고 새 run 을 만든다. 중간 실패 시 이전 run 을 되살린다.
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

  // 진행 중 주차 공표 금지 — 기존 markTeamPartsWeekReviewed 의 current_or_future_week 가드와 동일 정책.
  const activityDate = opts.today ?? getCurrentActivityDateIso();
  if (activityDate <= week.end_date) {
    throw new CrewWeekPublishError(
      422,
      "아직 진행 중인 주차는 공표할 수 없습니다. 주차가 종료된 후 공표해주세요.",
    );
  }

  // ⚠ 클라이언트가 보낸 숫자를 신뢰하지 않는다 — 서버가 최신 원천으로 다시 계산한다.
  const preview = await computeCrewWeekPreview({ organization, weekId, scope, today: opts.today });

  const prev = await loadActiveRun(weekId, organization, scope);
  const nowIso = new Date().toISOString();

  // 1) 이전 활성 run 을 닫는다(unique index 회피). 실패 시 아무것도 바뀌지 않는다.
  if (prev) {
    const { error } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .update({ reverted_at: nowIso })
      .eq("id", prev.id)
      .is("reverted_at", null);
    if (error) throw new CrewWeekPublishError(500, `이전 공표 종료 실패: ${error.message}`);
  }

  // 2) 새 run 삽입.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .insert({
      week_id: weekId,
      organization_slug: organization,
      scope: toFinalizeRunScope(scope),
      actor_id: actorId,
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
      skipped_count: 0,
      created_uws_ids: [],
      updated_uws: [],
    })
    .select("id,created_at")
    .single();

  if (insErr || !inserted) {
    // 롤백 — 이전 run 을 되살린다(중간 실패로 공표본이 사라지면 안 된다).
    if (prev) {
      await supabaseAdmin
        .from("cluster4_week_finalize_runs")
        .update({ reverted_at: null })
        .eq("id", prev.id);
    }
    throw new CrewWeekPublishError(500, `공표 저장 실패: ${insErr?.message ?? "unknown"}`);
  }

  const runId = (inserted as { id: string }).id;

  // 3) 크루별 결과 저장.
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
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("cluster4_week_finalize_run_crew_results")
        .insert(rows.slice(i, i + 500));
      if (error) {
        // 부분 반영 금지 — 새 run 을 통째로 되돌리고 이전 run 을 되살린다.
        await supabaseAdmin.from("cluster4_week_finalize_runs").delete().eq("id", runId);
        if (prev) {
          await supabaseAdmin
            .from("cluster4_week_finalize_runs")
            .update({ reverted_at: null })
            .eq("id", prev.id);
        }
        throw new CrewWeekPublishError(500, `크루 결과 저장 실패: ${error.message}`);
      }
    }
  }

  // 4) 조직 검수 상태 전환 — 여기서만 published 가 된다.
  await setWeekOrgResultStatus(weekId, organization, scope, "published", actorId);

  const result = await loadPublishedCrewWeekResult({ organization, weekId, scope });
  if (!result) throw new CrewWeekPublishError(500, "공표 후 결과 조회에 실패했습니다.");
  return result;
}

// ── [4] 공표 취소 ───────────────────────────────────────────────────────────
export async function unpublishCrewWeekResult(opts: {
  organization: OrganizationSlug;
  weekId: string;
  scope: OrgResultScope;
  actorId: string | null;
}): Promise<{ reverted: boolean; runId: string | null }> {
  const { organization, weekId, scope, actorId } = opts;
  const run = await loadActiveRun(weekId, organization, scope);
  if (!run) {
    // 멱등 — 이미 취소됐거나 공표된 적 없음. 상태만 되돌린다.
    await setWeekOrgResultStatus(weekId, organization, scope, "aggregating", actorId);
    return { reverted: false, runId: null };
  }

  // 물리 DELETE 금지 — reverted_at 으로 비활성화(감사 이력 보존).
  const { error } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .update({ reverted_at: new Date().toISOString() })
    .eq("id", run.id)
    .is("reverted_at", null);
  if (error) throw new CrewWeekPublishError(500, `공표 취소 실패: ${error.message}`);

  // 검수 완료 → 집계 중.
  await setWeekOrgResultStatus(weekId, organization, scope, "aggregating", actorId);
  return { reverted: true, runId: run.id };
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
