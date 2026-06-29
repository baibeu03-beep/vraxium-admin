// Server-only 데이터 레이어 — 주차 카드 집계 확정(weekly-card-finalization).
//
// 목적: 어드민이 특정 시즌/주차의 집계 결과를 미리 보고(preview), 확정(finalize)하거나
//       스냅샷만 재계산(recompute)한다. "집계 중"(tallying)으로 멈춘 주차를 확정 상태로
//       전환하는 단일 운영 진입점.
//
// ⚠ SoT 불변 (새 기준/새 컬럼 만들지 않음):
//   - 확정 상태 SoT      = weeks.result_published_at (기존 publishWeekResult 와 동일 단일 경로).
//   - 주차 결과 판정 SoT = growthCore.resolveWeekResultStatus (카드/주차인정 요약과 동일 함수).
//   - 집계 분포 기준     = user_week_statuses.status (기존 "주차 인정 결과" 요약과 동일 raw SoT).
//                          per-user 실무경험 verdict-fail 카드 override 는 적용하지 않는다.
//   - PMS 활동인정 공식  = lib/weeklyLeaguePmsAggregation(front weekly-league 이식, 새 공식 아님).
//                          데이터-게이트: cluster4_weekly_pms_activity + org_week_thresholds 있는
//                          (org,week) 만 PMS 공식(Star≥4 + confirmStar)으로 집계, 그 외는 uws 폴백.
//                          예: oranke 2026-spring W13 = 82/66/9/7. 개인 카드/snapshot 무변경(READ only).
//   - 스냅샷             = recomputeWeeklyCardsSnapshotsForUsers (기존 재계산 경로).
//   - 테스트 유저 제외   = fetchTestUserMarkerIds (test_user_markers, weekly-ranking 과 동일 기준).
//                          코호트(집계·snapshot 신선도·재계산) 전부 동일하게 시드 테스트 유저를 제외한다.
//   조회/일반/데모 경로(loadWeeklyCards·readWeeklyCardsSnapshot·getCluster4WeeklyCardsForProfileUser)는
//   전혀 건드리지 않는다 — 본 모듈은 쓰기(확정)·재계산 진입점일 뿐이며 DTO 계산 로직은 불변.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  fetchActiveRestPeriods,
  isSeasonRuleRestForWeekStart,
} from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";
import {
  resolveWeekResultStatus,
  type ResolveWeekResultInput,
} from "@/lib/growthCore";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { markWeekResultPublished } from "@/lib/adminWeekRecognitionsData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { computeWeeklyLeagueAggregation } from "@/lib/weeklyLeaguePmsAggregation";
import type {
  FinalizationAggregation,
  FinalizationMode,
  FinalizationSeasonOption,
  FinalizationSnapshotHealth,
  FinalizationWeekOption,
  FinalizationWeekStatus,
  WeeklyCardFinalizationPreview,
  WeeklyCardFinalizationResult,
} from "@/lib/adminWeeklyCardFinalizationTypes";

const DAY_MS = 86_400_000;

export class WeeklyCardFinalizationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WeeklyCardFinalizationError";
    this.status = status;
  }
}

const SEASON_TYPE_LABEL: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
  iso_year: number | null;
  iso_week: number | null;
  result_published_at: string | null;
};

const WEEK_SELECT =
  "id,season_key,week_number,start_date,end_date,iso_year,iso_week,result_published_at";

function seasonName(s: SeasonDefinitionRow): string {
  return (
    s.season_label ??
    (s.season_type ? SEASON_TYPE_LABEL[s.season_type] : null) ??
    s.season_key
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const ms = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return fmtDate(ms + days * DAY_MS);
}

// 오늘이 속한 주차 시작(월요일) ISO — 카드 경계 판정과 동일 함수(getCurrentWeekStartMs).
function currentWeekStartIso(): string | null {
  const ms = getCurrentWeekStartMs(getCurrentActivityDateIso());
  return ms == null ? null : fmtDate(ms);
}

function weekLabelOf(w: WeekRow): string {
  if (w.week_number != null) return `${w.week_number}주차`;
  if (w.iso_week != null) return `${w.iso_week}주(ISO)`;
  return "주차 미지정";
}

// ── 옵션(시즌/주차 드롭다운) ────────────────────────────────────────────
async function loadOptions(): Promise<{
  seasons: FinalizationSeasonOption[];
  weeks: FinalizationWeekOption[];
  weekRows: WeekRow[];
  activeRestPeriods: Awaited<ReturnType<typeof fetchActiveRestPeriods>>;
  curWeekStart: string | null;
}> {
  const [seasonRes, weekRes, activeRestPeriods] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type")
      .order("start_date", { ascending: false }),
    supabaseAdmin
      .from("weeks")
      .select(WEEK_SELECT)
      .order("start_date", { ascending: false }),
    fetchActiveRestPeriods(),
  ]);

  if (seasonRes.error) throw new WeeklyCardFinalizationError(500, seasonRes.error.message);
  if (weekRes.error) throw new WeeklyCardFinalizationError(500, weekRes.error.message);

  const seasons = ((seasonRes.data ?? []) as SeasonDefinitionRow[]).map((s) => ({
    seasonKey: s.season_key,
    seasonLabel: seasonName(s),
  }));
  const weekRows = (weekRes.data ?? []) as WeekRow[];
  const curWeekStart = currentWeekStartIso();

  const weeks: FinalizationWeekOption[] = weekRows.map((w) => {
    const start = w.start_date;
    const end = w.end_date ?? (start ? addDaysIso(start, 6) : null);
    const isOfficialRest =
      start != null &&
      (isSeasonRuleRestForWeekStart(start) ||
        matchOfficialRestPeriods(
          { startDate: start, endDate: end ?? start },
          activeRestPeriods,
        ).length > 0);
    return {
      weekId: w.id,
      seasonKey: w.season_key,
      weekNumber: w.week_number,
      weekLabel: weekLabelOf(w),
      startDate: start,
      endDate: end,
      resultPublishedAt: w.result_published_at ?? null,
      isCurrentWeek: curWeekStart != null && start === curWeekStart,
      isOfficialRest,
    };
  });

  return { seasons, weeks, weekRows, activeRestPeriods, curWeekStart };
}

// ── 주차 1건 resolve (seasonKey + weekNumber) ───────────────────────────
function resolveTargetWeek(
  weekRows: WeekRow[],
  seasonKey: string,
  weekNumber: number,
): WeekRow {
  const matches = weekRows.filter(
    (w) => w.season_key === seasonKey && w.week_number === weekNumber,
  );
  if (matches.length === 0) {
    throw new WeeklyCardFinalizationError(
      404,
      `해당 주차를 찾을 수 없습니다 (season=${seasonKey}, week=${weekNumber}).`,
    );
  }
  // 동일 (season_key, week_number) 중복은 운영상 없어야 하지만, 방어적으로 start_date 최신을 택한다.
  return matches.sort((a, b) =>
    (b.start_date ?? "").localeCompare(a.start_date ?? ""),
  )[0];
}

// ── 코호트 조회 (해당 주차 uws 보유자 + org 필터) ────────────────────────
type CohortMember = { userId: string; status: string };

async function loadCohort(
  weekStartDate: string,
  org: string | null,
): Promise<{ all: CohortMember[]; scoped: CohortMember[] }> {
  const [{ data, error }, testIds] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", weekStartDate),
    // 시드 테스트 유저 제외(weekly-ranking 과 동일 기준 = test_user_markers). 별도 기준 금지.
    fetchTestUserMarkerIds(),
  ]);
  if (error) throw new WeeklyCardFinalizationError(500, error.message);

  // user 당 1행으로 dedupe (동일 주차 중복 방어 — 첫 행 유지) + 테스트 유저 제외.
  const byUser = new Map<string, CohortMember>();
  for (const r of (data ?? []) as { user_id: string; status: string }[]) {
    if (testIds.has(r.user_id)) continue; // 테스트 유저는 코호트(집계·재계산·스냅샷)에서 제외.
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { userId: r.user_id, status: r.status });
    }
  }
  const all = Array.from(byUser.values());

  if (!org) return { all, scoped: all };

  const userIds = all.map((m) => m.userId);
  if (userIds.length === 0) return { all, scoped: [] };
  const { data: profData, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", org)
    .in("user_id", userIds);
  if (profErr) throw new WeeklyCardFinalizationError(500, profErr.message);
  const inOrg = new Set(
    ((profData ?? []) as { user_id: string }[]).map((p) => p.user_id),
  );
  return { all, scoped: all.filter((m) => inOrg.has(m.userId)) };
}

// ── 집계 분포 계산 (resolveWeekResultStatus 단일 SoT) ─────────────────────
function computeAggregation(
  cohort: CohortMember[],
  ctx: {
    isCurrentWeek: boolean;
    weekIsOfficialRest: boolean;
    currentPublished: boolean;
  },
): FinalizationAggregation {
  const base: Omit<ResolveWeekResultInput, "uwsStatus" | "isPublished"> = {
    isCurrentWeek: ctx.isCurrentWeek,
    weekIsOfficialRest: ctx.weekIsOfficialRest,
    // per-user 카드 verdict-fail override 는 코호트 집계에 적용하지 않는다(주차 인정 요약과 동일).
    experienceVerdictStatus: null,
  };
  const resolve = (status: string, isPublished: boolean) =>
    resolveWeekResultStatus({
      ...base,
      uwsStatus: status as ResolveWeekResultInput["uwsStatus"],
      isPublished,
    }).status;

  let growthSuccess = 0;
  let growthFail = 0;
  let personalRest = 0;
  let officialRest = 0;
  let pendingTally = 0;
  let uncategorized = 0;

  for (const m of cohort) {
    // 확정 후(공표 시뮬레이션) 분포 — 성공/실패/휴식 확정값.
    const finalized = resolve(m.status, true);
    // 현재 상태 — "아직 집계 중으로 남는 인원"(확정 후엔 0).
    const current = resolve(m.status, ctx.currentPublished);

    switch (finalized) {
      case "success":
        growthSuccess++;
        break;
      case "fail":
        growthFail++;
        break;
      case "personal_rest":
        personalRest++;
        break;
      case "official_rest":
        officialRest++;
        break;
      default:
        uncategorized++;
        break;
    }
    if (current === "tallying") pendingTally++;
  }

  return {
    totalCrew: cohort.length,
    growthChallenge: growthSuccess + growthFail,
    growthSuccess,
    growthFail,
    personalRest,
    officialRest,
    pendingTally,
    uncategorized,
  };
}

// ── 코호트 스냅샷 신선도 ────────────────────────────────────────────────
async function loadSnapshotHealth(
  cohort: CohortMember[],
): Promise<FinalizationSnapshotHealth> {
  const cohortSize = cohort.length;
  if (cohortSize === 0) {
    return { cohortSize: 0, present: 0, fresh: 0, stale: 0, missing: 0, isStale: false };
  }
  const userIds = cohort.map((m) => m.userId);
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale,dto_version")
    .in("user_id", userIds);
  if (error) throw new WeeklyCardFinalizationError(500, error.message);

  let fresh = 0;
  let stale = 0;
  const rows = (data ?? []) as { user_id: string; is_stale: boolean; dto_version: number }[];
  for (const r of rows) {
    const isStale = r.is_stale === true || r.dto_version !== WEEKLY_CARDS_DTO_VERSION;
    if (isStale) stale++;
    else fresh++;
  }
  const present = rows.length;
  const missing = cohortSize - present;
  return {
    cohortSize,
    present,
    fresh,
    stale,
    missing,
    isStale: stale > 0 || missing > 0,
  };
}

// 선택 주차 status + 집계 + 스냅샷 신선도를 한 번에 조립한다.
async function buildTargetStatusAndAggregation(
  target: WeekRow,
  org: string | null,
  curWeekStart: string | null,
  activeRestPeriods: Awaited<ReturnType<typeof fetchActiveRestPeriods>>,
): Promise<{
  status: FinalizationWeekStatus;
  aggregation: FinalizationAggregation;
  cohortAll: CohortMember[];
  cohortScoped: CohortMember[];
}> {
  const start = target.start_date;
  if (!start) {
    throw new WeeklyCardFinalizationError(
      422,
      "선택한 주차에 start_date 가 없어 집계할 수 없습니다.",
    );
  }
  const end = target.end_date ?? addDaysIso(start, 6);
  const isCurrentWeek = curWeekStart != null && start === curWeekStart;
  const weekIsOfficialRest =
    isSeasonRuleRestForWeekStart(start) ||
    matchOfficialRestPeriods({ startDate: start, endDate: end }, activeRestPeriods)
      .length > 0;
  const currentPublished = Boolean(target.result_published_at);

  const { all, scoped } = await loadCohort(start, org);

  // ── weekly-ranking 봄 정합 집계 재사용(front weekly-league 이식) ──
  //   org(encre/oranke/phalanx) + 2026-spring 종료 주차면 front 와 100% 동일한 집계
  //   (PMS 공식 데이터-게이트·예외 보정·공식휴식 0·uws 폴백)을 그대로 쓴다. 그 외(타 시즌/org=전체/
  //   미종료 주차)는 기존 uws 버킷팅 폴백. 집계 분포·snapshot 신선도 코호트 모두 동일 출처.
  let aggregation: FinalizationAggregation;
  let healthCohortIds: string[];
  const wl =
    org && target.season_key
      ? await computeWeeklyLeagueAggregation(org)
      : null;
  const wlWeek = wl?.byWeekId.get(target.id) ?? null;
  if (wlWeek) {
    // pendingTally(미확정) 의미 보존: 미공표면 도전 인원 전체가 집계중 표시, 공표하면 0.
    aggregation = {
      totalCrew: wlWeek.totalCrew,
      growthChallenge: wlWeek.growthChallenge,
      growthSuccess: wlWeek.growthSuccess,
      growthFail: wlWeek.growthFail,
      personalRest: wlWeek.personalRest,
      officialRest: wlWeek.officialRest,
      pendingTally: currentPublished ? 0 : wlWeek.growthChallenge,
      uncategorized: 0,
    };
    healthCohortIds = wlWeek.cohortUserIds;
  } else {
    aggregation = computeAggregation(scoped, {
      isCurrentWeek,
      weekIsOfficialRest,
      currentPublished,
    });
    healthCohortIds = scoped.map((m) => m.userId);
  }
  const snapshot = await loadSnapshotHealth(
    healthCohortIds.map((userId) => ({ userId, status: "" })),
  );

  const status: FinalizationWeekStatus = {
    weekId: target.id,
    seasonKey: target.season_key,
    weekNumber: target.week_number,
    weekLabel: weekLabelOf(target),
    startDate: start,
    endDate: end,
    resultPublishedAt: target.result_published_at ?? null,
    isFinalized: currentPublished,
    isCurrentWeek,
    isOfficialRest: weekIsOfficialRest,
    snapshot,
  };

  return { status, aggregation, cohortAll: all, cohortScoped: scoped };
}

// ── Public: preview ─────────────────────────────────────────────────────
export async function previewWeeklyCardFinalization(opts: {
  seasonKey: string | null;
  weekNumber: number | null;
  org: string | null;
}): Promise<WeeklyCardFinalizationPreview> {
  const { seasons, weeks, weekRows, activeRestPeriods, curWeekStart } =
    await loadOptions();

  let target: FinalizationWeekStatus | null = null;
  let aggregation: FinalizationAggregation | null = null;

  if (opts.seasonKey && opts.weekNumber != null) {
    const targetRow = resolveTargetWeek(weekRows, opts.seasonKey, opts.weekNumber);
    const built = await buildTargetStatusAndAggregation(
      targetRow,
      opts.org,
      curWeekStart,
      activeRestPeriods,
    );
    target = built.status;
    aggregation = built.aggregation;
  }

  return {
    seasons,
    weeks,
    target,
    aggregation,
    org: opts.org,
    generatedAt: new Date().toISOString(),
  };
}

// ── Public: finalize / recompute ────────────────────────────────────────
export async function runWeeklyCardFinalization(opts: {
  seasonKey: string;
  weekNumber: number;
  org: string | null;
  mode: FinalizationMode;
}): Promise<WeeklyCardFinalizationResult> {
  const { weekRows, activeRestPeriods, curWeekStart } = await loadOptions();
  const targetRow = resolveTargetWeek(weekRows, opts.seasonKey, opts.weekNumber);
  if (!targetRow.start_date) {
    throw new WeeklyCardFinalizationError(422, "선택한 주차에 start_date 가 없습니다.");
  }

  // 재계산 코호트 = 주차 전역(모든 org) 비-테스트 유저. 공표는 주차 전역 이벤트이므로 org 미적용,
  // 단 테스트 유저는 제외(요구사항 3 — 집계·재계산·스냅샷 코호트 모두 동일 제외 기준).
  const { all: nonTestCohort } = await loadCohort(targetRow.start_date, null);
  const nonTestIds = nonTestCohort.map((m) => m.userId);
  const recompute = async () => {
    const r = await recomputeWeeklyCardsSnapshotsForUsers(nonTestIds, { concurrency: 3 });
    return { requested: r.requested, recomputed: r.recomputed, failed: r.failed };
  };

  let published: WeeklyCardFinalizationResult["published"] = null;
  let snapshotRecompute = { requested: 0, recomputed: 0, failed: 0 };

  if (opts.mode === "finalize") {
    if (targetRow.result_published_at) {
      // 이미 확정됨 — 멱등하게 비-테스트 코호트 스냅샷만 재계산(재확정 효과). 공표값은 보존.
      published = {
        resultPublishedAt: targetRow.result_published_at,
        alreadyFinalized: true,
      };
      snapshotRecompute = await recompute();
    } else {
      // 미확정 → 공표 SoT 쓰기(markWeekResultPublished, 단일 공표 진입점) + 비-테스트 코호트 재계산.
      //   ⚠ publishWeekResult(전체 코호트 재계산)를 쓰지 않는다 — 본 경로는 테스트 유저를 제외한다.
      const { row } = await markWeekResultPublished(targetRow.id);
      published = { resultPublishedAt: row.result_published_at, alreadyFinalized: false };
      targetRow.result_published_at = row.result_published_at;
      snapshotRecompute = await recompute();
    }
  } else {
    // recompute: 공표 플래그 변경 없이 비-테스트 코호트 스냅샷만 재계산.
    snapshotRecompute = await recompute();
  }

  // 재계산/공표 후의 최신 status + (org 필터 반영) 집계.
  const built = await buildTargetStatusAndAggregation(
    targetRow,
    opts.org,
    curWeekStart,
    activeRestPeriods,
  );

  return {
    mode: opts.mode,
    target: built.status,
    aggregation: built.aggregation,
    published,
    snapshotRecompute,
    org: opts.org,
    generatedAt: new Date().toISOString(),
  };
}

// 재내보내기 — 라우트가 의존성 단순화를 위해 사용할 수 있도록.
export { recomputeWeeklyCardsSnapshotsForUsers };
