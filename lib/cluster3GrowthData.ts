import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { getGraduationThreshold, getPointLabels } from "@/lib/pointLabels";
import {
  GROWTH_DISPLAY_LABELS,
  type GrowthIndicatorsDto,
  type GrowthIndicatorsInternal,
  type GrowthPeriod,
  type GrowthPointLabeled,
  type GrowthProcess,
} from "@/lib/cluster3GrowthTypes";
// Growth Core 통일(5-B-1): 주차 결과/지표/상태를 cluster4 와 동일한 ResolvedWeek 기반으로 산출.
// 6-A: ResolvedWeek 소스를 snapshot-first 로 — cluster4_weekly_card_snapshots.cards 를 먼저 읽고,
//   없거나 invalid 하면 getWeeklyGrowth 로 fallback 한다(고객 stats-cards 핫패스 무거운 계산 회피).
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { foldGrowthMetrics, resolveGrowthStatus } from "@/lib/growthCore";
import type { WeekResultStatusKey } from "@/shared/growth.contracts";

// Cluster3 성장 지표 계산 — server-only.

export class GrowthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GrowthError";
    this.status = status;
  }
}

type ProfileRow = {
  user_id: string;
  growth_status: string | null;
  activity_started_at: string | null;
  activity_ended_at: string | null;
  organization_slug: string | null;
};

type WeekStatusRow = {
  status: string;
  year?: number;
  week_number?: number;
  week_start_date?: string | null;
  is_official_rest_override?: boolean;
};

// user_cumulative_points 실제 컬럼명에 맞춘다.
//   total_checks   → 별(star)/성장 점수 총합
//   total_advantages → 방패(shield) = net advantages (= raw - penalties)
//   total_penalties  → 번개(lightning)/penalty 총합
// (과거 total_stars/total_shields/total_lightnings 로 SELECT 하여 컬럼 부재로 500 발생 → 정정)
type PointRow = {
  total_checks: number | null;
  total_advantages: number | null;
  total_penalties: number | null;
  total_raw_advantages: number | null;
};

type SeasonStatusRow = { user_id?: string; status: string };

const DEFAULT_POINT_LABELS = { points: "점수", advantages: "이점", penalty: "패널티" };

// ─── route param → user_profiles.user_id 변환 ─────────────────────────
// URL 에 UUID 가 오면 user_profiles 에서 직접 매칭,
// 정수(legacy_user_id)가 오면 users 테이블을 경유해 UUID 로 변환.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveGrowthUserId(routeParam: string): Promise<string> {
  const id = String(routeParam ?? "").trim();
  if (!id) throw new GrowthError(400, "userId is empty");

  if (UUID_RE.test(id)) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("user_id", id)
      .maybeSingle();
    if (error) throw new GrowthError(500, error.message);
    if (data) return (data as { user_id: string }).user_id;
  }

  // integer legacy_user_id → users.id(UUID)
  if (/^\d+$/.test(id)) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("legacy_user_id", Number(id))
      .maybeSingle();
    if (error) throw new GrowthError(500, error.message);
    if (data) return (data as { id: string }).id;
  }

  throw new GrowthError(404, `user not found for param "${id}"`);
}

// ─── 현재 ISO 주차 ─────────────────────────────────────────────────

function getCurrentISOWeek(): { year: number; week: number } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// ─── 표시명 10종 우선순위 결정 ──────────────────────────────────────
//
//  10. graduated      → "성장 완료(졸업)"
//   9. suspended      → "성장 중단"
//   8. paused         → "성장 유보"
//   7. graduating     → "졸업 절차 중"
//   6. seasonal_rest  → "시즌 휴식 중"
//   5. weekly_rest    → "휴식(개인) 중"
//   4. 현재 주차 official_rest → "휴식(공식) 중"
//   3. h <= 1 && active        → "클럽 온보딩 중"
//   2. a >= threshold && active → "추가 성장 중"
//   1. active                   → "성장 중"

// 성장 상태 10종 판정 SoT = growthCore.resolveGrowthStatus (이 파일은 로컬 판정 함수를 두지 않는다).

// ─── ResolvedWeek 소스 (snapshot-first, fallback=getWeeklyGrowth) ───
//
// buildIndicators 가 fold 에 쓰는 최소 필드만 담은 정규형. snapshot(public DTO)·
// fallback(internal DTO) 어느 쪽이든 동일 shape 로 정규화한다.
//   resultStatus = card status(6종) / isTransition = isTransitionWeekStart(startDate) 재계산.
type ResolvedCardLite = {
  resultStatus: WeekResultStatusKey;
  startDate: string;
  endDate: string;
  isTransition: boolean;
};

const WEEK_RESULT_STATUS_SET = new Set<string>([
  "running",
  "tallying",
  "success",
  "fail",
  "personal_rest",
  "official_rest",
]);

// snapshot public 카드 → ResolvedCardLite. shape 부족(필드 누락/상태값 비정상)이면 null → fallback.
function snapshotCardsToLite(
  cards: Cluster4WeeklyCardDto[],
): ResolvedCardLite[] | null {
  const lite: ResolvedCardLite[] = [];
  for (const c of cards) {
    if (typeof c.startDate !== "string" || typeof c.endDate !== "string") {
      return null;
    }
    if (!WEEK_RESULT_STATUS_SET.has(c.userWeekStatus)) return null;
    lite.push({
      resultStatus: c.userWeekStatus,
      startDate: c.startDate,
      endDate: c.endDate,
      // 내부 카드의 isTransition 과 동일 산식(isTransitionWeekStart(startDate)).
      isTransition: isTransitionWeekStart(c.startDate),
    });
  }
  return lite;
}

// 1순위: snapshot.cards (무거운 계산 0). 2순위: getWeeklyGrowth fallback.
//   hit → 사용(빈 배열이어도 fresh 진실). stale → 비어있지 않을 때만 사용(placeholder[] 회피).
//   miss/error/shape부족/placeholder → fallback.
async function getResolvedCardsForUser(
  userId: string,
): Promise<{ cards: ResolvedCardLite[]; source: "snapshot" | "fallback" }> {
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status === "hit" || (snap.status === "stale" && snap.cards.length > 0)) {
    const lite = snapshotCardsToLite(snap.cards);
    if (lite) return { cards: lite, source: "snapshot" };
  }
  // fallback: 실시간 계산(무겁다). snapshot 백필/즉시갱신이 정상화되면 거의 타지 않는다.
  const g = await getWeeklyGrowth(userId);
  const cards: ResolvedCardLite[] = (g?.weeklyCards ?? []).map((c) => ({
    resultStatus: c.resultStatus,
    startDate: c.startDate,
    endDate: c.endDate,
    isTransition: c.isTransition,
  }));
  return { cards, source: "fallback" };
}

// ─── 내부 빌더 ──────────────────────────────────────────────────────

function buildIndicators(
  profile: ProfileRow,
  weekRows: WeekStatusRow[],
  cards: ResolvedCardLite[],
  pts: PointRow | null,
  currentWeekStatus: string | null,
  seasonRows: SeasonStatusRow[],
): GrowthIndicatorsInternal {
  const org = profile.organization_slug;
  const orgValid = org && isOrganizationSlug(org) ? (org as OrganizationSlug) : null;
  const threshold = orgValid ? getGraduationThreshold(orgValid) : null;

  // 주차 지표 — cluster4 resolved 카드(ResolvedWeek) 기반 클린 파이프라인.
  //   a/b/c = resolveWeekResultStatus 결과 fold (미공표 success 는 tallying 으로 빠지고
  //   verdict fail 전환이 자동 반영됨). d = 공식휴식 카드. e = a+b+c.
  const { approvedWeeks: a, failedWeeks: b, restWeeks: c } = foldGrowthMetrics({
    weeks: cards.map((card) => ({
      status: card.resultStatus,
      isTransition: card.isTransition,
    })),
    restSeasonCount: 0,
  });
  const d = cards.filter(
    (card) => !card.isTransition && card.resultStatus === "official_rest",
  ).length;
  // 지나간 주차 h: end_date < today 인 전환 제외 주차 (현재 진행중/미래 제외).
  const todayIso = new Date().toISOString().slice(0, 10);
  const h = cards.filter(
    (card) => !card.isTransition && card.endDate < todayIso,
  ).length;

  // overrideCount(_debug 전용): 공식휴식 활동 인정 표시 — raw uws 기준 유지.
  let overrideCount = 0;
  for (const row of weekRows) {
    if (row.week_start_date && isTransitionWeekStart(row.week_start_date)) continue;
    if (row.is_official_rest_override) overrideCount++;
  }

  // f = 성장 휴식 시즌 (시즌 전체 휴식 신청)
  // g = 성장(성공) 시즌 (f 가 아닌 시즌)
  let f = 0, g = 0;
  for (const sr of seasonRows) {
    if (sr.status === "rest") f++;
    else g++;
  }

  const displayKey = resolveGrowthStatus({
    growthStatus: profile.growth_status,
    currentWeekStatus,
    approvedWeeks: a,
    elapsedWeeks: h,
    graduationThreshold: threshold,
  });

  const process: GrowthProcess = {
    growthStatus: profile.growth_status,
    growthStatusDisplay: GROWTH_DISPLAY_LABELS[displayKey],
    growthDisplayKey: displayKey,
    activityStartedAt: profile.activity_started_at,
    activityStartedAtDisplay: profile.activity_started_at
      ? new Date(profile.activity_started_at).toISOString().slice(0, 10)
      : "—",
    activityEndedAt: profile.activity_ended_at,
    activityEndedAtDisplay: profile.activity_ended_at
      ? new Date(profile.activity_ended_at).toISOString().slice(0, 10)
      : "Be Cluving",
  };

  const period: GrowthPeriod = { a, b, c, d, e: a + b + c, h, f, g };

  const j = pts?.total_checks ?? 0;
  const k0 = pts?.total_raw_advantages ?? 0;
  const l = Math.abs(pts?.total_penalties ?? 0);
  const k = k0 - l;
  const storedShields = pts?.total_advantages ?? 0;

  const labels = orgValid ? getPointLabels(orgValid) : DEFAULT_POINT_LABELS;

  const point: GrowthPointLabeled = {
    points: j,
    rawAdvantages: k0,
    penalty: l,
    netAdvantages: k,
    pointsLabel: labels.points,
    advantagesLabel: labels.advantages,
    penaltyLabel: labels.penalty,
  };

  return {
    userId: profile.user_id,
    organizationSlug: org,
    process,
    period,
    point,
    _debug: {
      graduationThreshold: threshold,
      graduationEligible: threshold !== null && a >= threshold,
      integrityOk: storedShields === k,
      currentWeekStatus,
      officialRestOverrideCount: overrideCount,
      weekRowCount: weekRows.length,
      seasonRowCount: seasonRows.length,
    },
  };
}

function toPublicDto(internal: GrowthIndicatorsInternal): GrowthIndicatorsDto {
  const { _debug: _, ...dto } = internal;
  return dto;
}

// ─── 현재 주차 상태 조회 헬퍼 ───────────────────────────────────────

async function fetchCurrentWeekStatus(userId: string): Promise<string | null> {
  const { year, week } = getCurrentISOWeek();
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("status,week_start_date")
    .eq("user_id", userId)
    .eq("year", year)
    .eq("week_number", week)
    .maybeSingle();
  const row = data as { status: string; week_start_date: string | null } | null;
  if (row?.week_start_date && isTransitionWeekStart(row.week_start_date)) return null;
  return row?.status ?? null;
}

async function fetchCurrentWeekStatusBatch(
  userIds: string[],
): Promise<Map<string, string>> {
  const { year, week } = getCurrentISOWeek();
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id,status,week_start_date")
    .in("user_id", userIds)
    .eq("year", year)
    .eq("week_number", week);

  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    user_id: string;
    status: string;
    week_start_date: string | null;
  }>) {
    // 전환 주차는 현재 주차 휴식 판정에서 제외(공식 휴식 아님).
    if (row.week_start_date && isTransitionWeekStart(row.week_start_date)) continue;
    map.set(row.user_id, row.status);
  }
  return map;
}

// ─── 공개 API (UI 용) ───────────────────────────────────────────────

export async function getGrowthIndicators(
  userId: string,
): Promise<GrowthIndicatorsDto> {
  const internal = await getGrowthIndicatorsInternal(userId);
  return toPublicDto(internal);
}

export async function getGrowthIndicatorsBatch(
  userIds: string[],
): Promise<GrowthIndicatorsDto[]> {
  const internals = await getGrowthIndicatorsBatchInternal(userIds);
  return internals.map(toPublicDto);
}

// ─── 내부 API (디버깅 · 테스트 · 관리자 검증) ──────────────────────

export async function getGrowthIndicatorsInternal(
  userId: string,
): Promise<GrowthIndicatorsInternal> {
  const [profileRes, weekRes, pointRes, seasonRes, currentWeekStatus, resolvedCards] =
    await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
        .eq("user_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("user_week_statuses")
        .select("status,week_start_date,is_official_rest_override")
        .eq("user_id", userId),
      supabaseAdmin
        .from("user_cumulative_points")
        .select("total_checks,total_advantages,total_penalties,total_raw_advantages")
        .eq("user_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("user_season_statuses")
        .select("status")
        .eq("user_id", userId),
      fetchCurrentWeekStatus(userId),
      // ResolvedWeek 카드 소스 — snapshot-first(무거운 계산 0), 없으면 getWeeklyGrowth fallback.
      getResolvedCardsForUser(userId),
    ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (weekRes.error) throw new GrowthError(500, weekRes.error.message);
  if (pointRes.error) throw new GrowthError(500, pointRes.error.message);
  if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

  const profile = (profileRes.data ?? null) as ProfileRow | null;
  if (!profile) throw new GrowthError(404, "user_profiles not found");

  const weekRows = (weekRes.data ?? []) as WeekStatusRow[];
  const seasonRows = (seasonRes.data ?? []) as SeasonStatusRow[];

  if (weekRows.length === 0) {
    console.warn(
      `[growth] user_week_statuses is EMPTY for user ${userId} — all Period week counts will be 0`,
    );
  }
  if (seasonRows.length === 0) {
    console.warn(
      `[growth] user_season_statuses is EMPTY for user ${userId} — season counts (f/g) will be 0`,
    );
  }

  console.log(
    "[cluster3][growth] card source",
    `user=${userId}`,
    resolvedCards.source,
  );
  return buildIndicators(
    profile,
    weekRows,
    resolvedCards.cards,
    (pointRes.data ?? null) as PointRow | null,
    currentWeekStatus,
    seasonRows,
  );
}

export async function getGrowthIndicatorsBatchInternal(
  userIds: string[],
): Promise<GrowthIndicatorsInternal[]> {
  if (userIds.length === 0) return [];

  const [profileRes, weekRes, pointRes, seasonRes, currentWeekMap] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status,week_start_date,is_official_rest_override")
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_cumulative_points")
      .select("user_id,total_checks,total_advantages,total_penalties,total_raw_advantages")
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status")
      .in("user_id", userIds),
    fetchCurrentWeekStatusBatch(userIds),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (weekRes.error) throw new GrowthError(500, weekRes.error.message);
  if (pointRes.error) throw new GrowthError(500, pointRes.error.message);
  if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

  const profiles = (profileRes.data ?? []) as ProfileRow[];
  const allWeeks = (weekRes.data ?? []) as (WeekStatusRow & { user_id: string })[];
  const allPoints = (pointRes.data ?? []) as (PointRow & { user_id: string })[];
  const allSeasons = (seasonRes.data ?? []) as (SeasonStatusRow & { user_id: string })[];

  const weeksByUser = new Map<string, WeekStatusRow[]>();
  for (const row of allWeeks) {
    const list = weeksByUser.get(row.user_id) ?? [];
    list.push(row);
    weeksByUser.set(row.user_id, list);
  }

  const pointsByUser = new Map<string, PointRow>();
  for (const row of allPoints) {
    pointsByUser.set(row.user_id, row);
  }

  const seasonsByUser = new Map<string, SeasonStatusRow[]>();
  for (const row of allSeasons) {
    const list = seasonsByUser.get(row.user_id!) ?? [];
    list.push(row);
    seasonsByUser.set(row.user_id!, list);
  }

  // ResolvedWeek 카드 소스 — snapshot-first(무거운 계산 0), miss/invalid 시 getWeeklyGrowth fallback.
  //   대량 배치에서 snapshot 이 fresh 하면 fallback(실시간 계산)을 거의 타지 않는다.
  const cardsByUser = new Map<string, ResolvedCardLite[]>();
  let snapshotHits = 0;
  let fallbacks = 0;
  await Promise.all(
    profiles.map(async (profile) => {
      const r = await getResolvedCardsForUser(profile.user_id);
      cardsByUser.set(profile.user_id, r.cards);
      if (r.source === "snapshot") snapshotHits++;
      else fallbacks++;
    }),
  );
  console.log(
    "[cluster3][growth] batch card source",
    `snapshot=${snapshotHits}`,
    `fallback=${fallbacks}`,
  );

  return profiles.map((profile) =>
    buildIndicators(
      profile,
      weeksByUser.get(profile.user_id) ?? [],
      cardsByUser.get(profile.user_id) ?? [],
      pointsByUser.get(profile.user_id) ?? null,
      currentWeekMap.get(profile.user_id) ?? null,
      seasonsByUser.get(profile.user_id) ?? [],
    ),
  );
}
