import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getSeasonForDate,
  isTransitionWeekStart,
  seasonDbKey,
} from "@/lib/seasonCalendar";
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
import {
  readWeeklyCardsSnapshot,
  readWeeklyCardsSnapshotBatch,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { foldGrowthMetrics, resolveGrowthStatusDetail } from "@/lib/growthCore";
import { rosterActivityRate } from "@/lib/rosterCardStats";
import { GROWTH_CARD_CONCURRENCY, mapWithConcurrency } from "@/lib/concurrency";
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

// PointRow = 전기간 누적 포인트 (별/방패/번개).
//   total_checks         → 별(star)/성장 점수 총합  = Σ user_weekly_points.points
//   total_raw_advantages → 방패 raw                 = Σ user_weekly_points.advantages
//   total_penalties      → 번개(lightning)/penalty  = Σ user_weekly_points.penalty
//   total_advantages     → 방패 net (= raw - |penalty|)
// SoT = user_weekly_points 직접합산.
//   과거: user_cumulative_points 캐시 read. 그러나 누적 동기화 트리거
//   (2026-05-28_cumulative_points_auto_sync.sql)는 컬럼명 불일치(total_stars 부재)로
//   이 DB 에 미적용 → weekly write 후 캐시 stale 위험. 이력서 카드와 동일하게 원천 직접합산.
type PointRow = {
  total_checks: number | null;
  total_advantages: number | null;
  total_penalties: number | null;
  total_raw_advantages: number | null;
};

// user_weekly_points 전체기간 직접합산 → PointRow per user (season/week 무필터).
// 행이 없는 유저는 Map 에 부재 → 호출부에서 null 처리(기존 캐시-미존재 시멘틱과 동일).
async function sumWeeklyPointsByUser(
  userIds: string[],
): Promise<Map<string, PointRow>> {
  if (userIds.length === 0) return new Map();
  const acc = new Map<string, { star: number; adv: number; pen: number }>();
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,points,advantages,penalty")
      .in("user_id", userIds)
      .range(from, from + page - 1);
    if (error) throw new GrowthError(500, error.message);
    const batch = (data ?? []) as Array<{
      user_id: string;
      points: number | null;
      advantages: number | null;
      penalty: number | null;
    }>;
    for (const r of batch) {
      const cur = acc.get(r.user_id) ?? { star: 0, adv: 0, pen: 0 };
      cur.star += r.points ?? 0;
      cur.adv += r.advantages ?? 0;
      cur.pen += r.penalty ?? 0;
      acc.set(r.user_id, cur);
    }
    if (batch.length < page) break;
    from += page;
  }
  const out = new Map<string, PointRow>();
  for (const [uid, s] of acc) {
    out.set(uid, {
      total_checks: s.star,
      total_raw_advantages: s.adv,
      total_penalties: s.pen,
      total_advantages: s.adv - Math.abs(s.pen), // net (integrity 항상 OK)
    });
  }
  return out;
}

type SeasonStatusRow = {
  user_id?: string;
  status: string;
  season_key?: string | null;
};

// ─── 수동 오버라이드 audit 메타 (user_growth_status_audit 최신 1건) ──
//
// 마이그레이션(2026-06-07_user_growth_status_audit.sql) 미적용 환경에서도
// 성장 지표 자체는 깨지지 않도록 best-effort 로 조회한다(실패 → 빈 맵 + warn).
type OverrideAuditMeta = {
  reason: string | null;
  changedByName: string | null;
  changedAt: string | null;
};

async function fetchOverrideAuditMeta(
  userIds: string[],
): Promise<Map<string, OverrideAuditMeta>> {
  const out = new Map<string, OverrideAuditMeta>();
  if (userIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("user_growth_status_audit")
    .select("user_id,reason,changed_by,created_at")
    .in("user_id", userIds)
    .order("created_at", { ascending: false });
  if (error) {
    // 테이블 미생성(마이그레이션 전) 등 — 메타 없이 진행.
    console.warn("[cluster3][growth] override audit unavailable:", error.message);
    return out;
  }
  const rows = (data ?? []) as Array<{
    user_id: string;
    reason: string | null;
    changed_by: string | null;
    created_at: string | null;
  }>;
  // created_at desc 정렬 → 사용자별 첫 행이 최신.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!latest.has(r.user_id)) latest.set(r.user_id, r);
  }
  // 변경자 표시명 resolve (관리자 이름 SoT = user_profiles.display_name).
  const actorIds = [
    ...new Set([...latest.values()].map((r) => r.changed_by).filter(Boolean)),
  ] as string[];
  const nameMap = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: names } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", actorIds);
    for (const n of (names ?? []) as Array<{
      user_id: string;
      display_name: string | null;
    }>) {
      if (n.display_name) nameMap.set(n.user_id, n.display_name);
    }
  }
  for (const [uid, r] of latest) {
    out.set(uid, {
      reason: r.reason,
      changedByName: r.changed_by ? (nameMap.get(r.changed_by) ?? r.changed_by) : null,
      changedAt: r.created_at,
    });
  }
  return out;
}

// 현재 시즌 db key ("2026-spring" 형식) — 시즌 휴식 자동 판정 기준.
function currentSeasonDbKey(): string | null {
  const season = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return season ? seasonDbKey(season) : null;
}

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

  // integer legacy_user_id → users.id(UUID) — 레거시 호환 fallback.
  // B안 복합키 (2026-06-07): legacy_user_id 는 (source_system, legacy_user_id) 복합
  // 식별 체계라 단독으로는 모호할 수 있다. limit(2) 로 모호성을 감지해 fail-closed —
  // 같은 숫자가 2명 이상이면 잘못된 사용자 해석 대신 명시적 409.
  if (/^\d+$/.test(id)) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("legacy_user_id", Number(id))
      .limit(2);
    if (error) throw new GrowthError(500, error.message);
    const rows = (data ?? []) as { id: string }[];
    if (rows.length > 1) {
      throw new GrowthError(
        409,
        `legacy_user_id "${id}" is ambiguous under the composite (source_system, legacy_user_id) scheme — query by user_id (UUID) instead`,
      );
    }
    if (rows.length === 1) return rows[0].id;
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

// ─── 표시명 10종 우선순위 결정 (2026-06-07 graduating 자동 계산 개정) ──
//
//  10. graduated      → "성장 완료(졸업)"   (운영 override)
//   9. suspended      → "성장 중단"         (운영 override)
//   8. paused         → "성장 유보"         (운영 override)
//   7. seasonal_rest  → "시즌 휴식 중"
//   6. weekly_rest    → "휴식(개인) 중"
//   5. 현재 주차 official_rest → "휴식(공식) 중"
//   4. h <= 1                  → "클럽 온보딩 중"
//   3. a >= 29 && 미졸업        → "졸업 절차 중" (자동 — DB graduating 수동값 비신뢰)
//   2. a >= threshold           → "추가 성장 중"
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
  currentSeasonKey: string | null,
  overrideMeta: OverrideAuditMeta | null,
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
  // g = 성장(성공) 시즌 (f·중단이 아닌 시즌)
  let f = 0, g = 0;
  for (const sr of seasonRows) {
    if (sr.status === "rest") f++;
    else if (sr.status === "stopped") { /* 중단 시즌은 성공 시즌(g)에 포함하지 않음 */ }
    else g++;
  }

  // 시즌 휴식 자동 판정 = 현재 시즌에 user_season_statuses.status='rest' 존재.
  const seasonRestActive =
    currentSeasonKey !== null &&
    seasonRows.some(
      (sr) => sr.status === "rest" && sr.season_key === currentSeasonKey,
    );
  // 시즌 중단 자동 판정 = 현재 시즌에 user_season_statuses.status='stopped' 존재(season-scoped).
  const seasonStoppedActive =
    currentSeasonKey !== null &&
    seasonRows.some(
      (sr) => sr.status === "stopped" && sr.season_key === currentSeasonKey,
    );

  const resolution = resolveGrowthStatusDetail({
    growthStatus: profile.growth_status,
    seasonRestActive,
    seasonStoppedActive,
    currentWeekStatus,
    approvedWeeks: a,
    elapsedWeeks: h,
    graduationThreshold: threshold,
  });
  const displayKey = resolution.display;

  const process: GrowthProcess = {
    growthStatus: profile.growth_status,
    growthStatusDisplay: GROWTH_DISPLAY_LABELS[displayKey],
    growthDisplayKey: displayKey,
    autoGrowthStatusKey: resolution.auto,
    autoGrowthStatusDisplay: GROWTH_DISPLAY_LABELS[resolution.auto],
    manualOverrideStatus: resolution.override,
    manualOverrideReason: resolution.override ? (overrideMeta?.reason ?? null) : null,
    manualOverrideByName: resolution.override
      ? (overrideMeta?.changedByName ?? null)
      : null,
    manualOverrideAt: resolution.override ? (overrideMeta?.changedAt ?? null) : null,
    overrideMismatch: resolution.overrideMismatch,
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
  const [
    profileRes,
    weekRes,
    pointMap,
    seasonRes,
    currentWeekStatus,
    resolvedCards,
    overrideMetaMap,
  ] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_week_statuses")
      .select("status,week_start_date,is_official_rest_override")
      .eq("user_id", userId),
    // 누적 포인트 = user_weekly_points 전기간 직접합산 (캐시 의존 제거).
    sumWeeklyPointsByUser([userId]),
    supabaseAdmin
      .from("user_season_statuses")
      .select("status,season_key")
      .eq("user_id", userId),
    fetchCurrentWeekStatus(userId),
    // ResolvedWeek 카드 소스 — snapshot-first(무거운 계산 0), 없으면 getWeeklyGrowth fallback.
    getResolvedCardsForUser(userId),
    fetchOverrideAuditMeta([userId]),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (weekRes.error) throw new GrowthError(500, weekRes.error.message);
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
    pointMap.get(userId) ?? null,
    currentWeekStatus,
    seasonRows,
    currentSeasonDbKey(),
    overrideMetaMap.get(userId) ?? null,
  );
}

export async function getGrowthIndicatorsBatchInternal(
  userIds: string[],
): Promise<GrowthIndicatorsInternal[]> {
  if (userIds.length === 0) return [];

  const [profileRes, weekRes, pointsByUser, seasonRes, currentWeekMap, overrideMetaMap] =
    await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
        .in("user_id", userIds),
      supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,status,week_start_date,is_official_rest_override")
        .in("user_id", userIds),
      // 누적 포인트 = user_weekly_points 전기간 직접합산 per user (캐시 의존 제거).
      sumWeeklyPointsByUser(userIds),
      supabaseAdmin
        .from("user_season_statuses")
        .select("user_id,status,season_key")
        .in("user_id", userIds),
      fetchCurrentWeekStatusBatch(userIds),
      fetchOverrideAuditMeta(userIds),
    ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (weekRes.error) throw new GrowthError(500, weekRes.error.message);
  if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

  const profiles = (profileRes.data ?? []) as ProfileRow[];
  const allWeeks = (weekRes.data ?? []) as (WeekStatusRow & { user_id: string })[];
  const allSeasons = (seasonRes.data ?? []) as (SeasonStatusRow & { user_id: string })[];

  const weeksByUser = new Map<string, WeekStatusRow[]>();
  for (const row of allWeeks) {
    const list = weeksByUser.get(row.user_id) ?? [];
    list.push(row);
    weeksByUser.set(row.user_id, list);
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
  // 무제한 팬아웃 금지 — per-user snapshot 조회를 GROWTH_CARD_CONCURRENCY 로 묶는다(풀 포화 방지).
  await mapWithConcurrency(profiles, GROWTH_CARD_CONCURRENCY, async (profile) => {
    const r = await getResolvedCardsForUser(profile.user_id);
    cardsByUser.set(profile.user_id, r.cards);
    if (r.source === "snapshot") snapshotHits++;
    else fallbacks++;
  });
  console.log(
    "[cluster3][growth] batch card source",
    `users=${profiles.length}`,
    `snapshot=${snapshotHits}`,
    `fallback=${fallbacks}`,
    `concurrency=${GROWTH_CARD_CONCURRENCY}`,
  );

  const seasonKey = currentSeasonDbKey();
  return profiles.map((profile) =>
    buildIndicators(
      profile,
      weeksByUser.get(profile.user_id) ?? [],
      cardsByUser.get(profile.user_id) ?? [],
      pointsByUser.get(profile.user_id) ?? null,
      currentWeekMap.get(profile.user_id) ?? null,
      seasonsByUser.get(profile.user_id) ?? [],
      seasonKey,
      overrideMetaMap.get(profile.user_id) ?? null,
    ),
  );
}

// ─── displayGrowthStatus 경량 배치 (고객앱 /crews graft 용) ─────────────
// getGrowthIndicatorsBatchInternal 에서 상태 판정에 불필요한 무거운 소스
// (user_weekly_points 전기간 합산 · user_week_statuses 전체 · override audit 메타)를
// 뺀 변형. 판정 입력(a/h fold · 현재주 상태 · 시즌휴식 · 졸업 threshold)과
// buildIndicators 경로를 그대로 재사용하므로 상태 계산 drift 가 없다.
//   - weekRows=[] / pts=null / overrideMeta=null 은 process 의 상태 4필드
//     (growthDisplayKey/autoGrowthStatusKey/manualOverrideStatus/overrideMismatch)에
//     영향이 없다 (_debug·point·override 메타 표기 전용 입력).
export type GrowthStatusResolutionRow = {
  userId: string;
  organizationSlug: string | null;
  growthStatusRaw: GrowthProcess["growthStatus"];
  autoGrowthStatusKey: GrowthProcess["autoGrowthStatusKey"];
  manualOverrideStatus: GrowthProcess["manualOverrideStatus"];
  displayGrowthStatus: GrowthProcess["growthDisplayKey"];
  overrideMismatch: GrowthProcess["overrideMismatch"];
};

export async function getGrowthStatusResolutionBatch(
  userIds: string[],
): Promise<GrowthStatusResolutionRow[]> {
  if (userIds.length === 0) return [];

  const [profileRes, seasonRes, currentWeekMap] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status,season_key")
      .in("user_id", userIds),
    fetchCurrentWeekStatusBatch(userIds),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

  const profiles = (profileRes.data ?? []) as ProfileRow[];
  const allSeasons = (seasonRes.data ?? []) as (SeasonStatusRow & { user_id: string })[];

  const seasonsByUser = new Map<string, SeasonStatusRow[]>();
  for (const row of allSeasons) {
    const list = seasonsByUser.get(row.user_id!) ?? [];
    list.push(row);
    seasonsByUser.set(row.user_id!, list);
  }

  // ResolvedWeek 카드 — snapshot-first (배치 internal 과 동일 소스).
  const cardsByUser = new Map<string, ResolvedCardLite[]>();
  let snapshotHits = 0;
  let fallbacks = 0;
  // 무제한 팬아웃 금지 — per-user snapshot 조회를 GROWTH_CARD_CONCURRENCY 로 묶는다(풀 포화 방지).
  await mapWithConcurrency(profiles, GROWTH_CARD_CONCURRENCY, async (profile) => {
    const r = await getResolvedCardsForUser(profile.user_id);
    cardsByUser.set(profile.user_id, r.cards);
    if (r.source === "snapshot") snapshotHits++;
    else fallbacks++;
  });
  console.log(
    "[cluster3][growth-status-batch] card source",
    `users=${profiles.length}`,
    `snapshot=${snapshotHits}`,
    `fallback=${fallbacks}`,
    `concurrency=${GROWTH_CARD_CONCURRENCY}`,
  );

  const seasonKey = currentSeasonDbKey();
  return profiles.map((profile) => {
    const internal = buildIndicators(
      profile,
      [], // weekRows — _debug 전용 입력
      cardsByUser.get(profile.user_id) ?? [],
      null, // pts — point 표기 전용 입력
      currentWeekMap.get(profile.user_id) ?? null,
      seasonsByUser.get(profile.user_id) ?? [],
      seasonKey,
      null, // overrideMeta — 표기 전용 입력
    );
    const p = internal.process;
    return {
      userId: profile.user_id,
      organizationSlug: profile.organization_slug,
      growthStatusRaw: p.growthStatus,
      autoGrowthStatusKey: p.autoGrowthStatusKey,
      manualOverrideStatus: p.manualOverrideStatus,
      displayGrowthStatus: p.growthDisplayKey,
      overrideMismatch: p.overrideMismatch,
    };
  });
}

// ─── 어드민 멤버 로스터 배치 (/admin/members 크루 목록) ──────────────────
// getGrowthStatusResolutionBatch 와 동일한 판정 경로(buildIndicators)지만,
// 표시 성장상태 + 성장 성공/가능 주차(period.a/e) + 활동 완료율(카드 numerator/denominator)을
// 함께 반환한다. 카드를 사용자당 1회만 읽어(snapshot-first, getResolvedCardsForUser 와 동일
// 폴백 규칙) 성장지표·활동완료율을 동시에 산출한다.
//   - successWeeks = period.a (성장(성공) 주차)
//   - growableWeeks = period.e = a+b+c (성장 가능 주차)
//   - activityRate = round(완료 라인/개설 라인 ×100) — cluster1ResumeData.computeActivityCompletion
//     정의와 동일(전환 제외·card.growthNumerator/Denominator 합, available 0 → 0). 카드 미가용=0/0/0.
export type GrowthRosterRow = {
  userId: string;
  displayGrowthStatus: GrowthProcess["growthDisplayKey"];
  successWeeks: number;
  growableWeeks: number;
  activityAvailable: number;
  activityCompleted: number;
  activityRate: number;
};

export async function getGrowthRosterBatch(
  userIds: string[],
  // 시즌 키 override(미지정=현재 시즌). /admin/members 명부는 operationalSeasonDbKey 를 넘긴다.
  seasonKeyOverride?: string | null,
): Promise<GrowthRosterRow[]> {
  if (userIds.length === 0) return [];

  const [profileRes, seasonRes, currentWeekMap] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status,season_key")
      .in("user_id", userIds),
    fetchCurrentWeekStatusBatch(userIds),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

  const profiles = (profileRes.data ?? []) as ProfileRow[];
  const allSeasons = (seasonRes.data ?? []) as (SeasonStatusRow & { user_id: string })[];

  const seasonsByUser = new Map<string, SeasonStatusRow[]>();
  for (const row of allSeasons) {
    const list = seasonsByUser.get(row.user_id!) ?? [];
    list.push(row);
    seasonsByUser.set(row.user_id!, list);
  }

  // 카드 = snapshot 배치 읽기(.in() 단일 SELECT, N→1). hit/stale(비어있지 않음)은 그 카드를 쓰고,
  // miss/error/손상만 개별 fallback(실시간 계산 — snapshot 정상화 시 거의 없음). SoT 동일(같은 테이블/카드).
  const snapByUser = await readWeeklyCardsSnapshotBatch(profiles.map((p) => p.user_id));
  const liteByUser = new Map<string, ResolvedCardLite[]>();
  const activityByUser = new Map<string, { available: number; completed: number }>();
  // snapshot 조회가 실패한(status:"error" — 예: statement timeout) 사용자. 이들은 무거운 실시간
  // 폴백으로 빠지지 않고(전체 요청 timeout/hang 유발) 결과에서 제외한다 → 호출부가 "-"로 fail-soft.
  const failedUserIds = new Set<string>();
  // snapshot 은 위에서 배치(.in())로 이미 읽었다. 여기 per-user 작업은 miss(신규 유저)에만
  // 실시간 폴백을 타므로 대개 가볍지만, 콜드 캐시(전원 miss) 시 무제한 팬아웃이 될 수 있어
  // GROWTH_CARD_CONCURRENCY 로 묶는다.
  await mapWithConcurrency(profiles, GROWTH_CARD_CONCURRENCY, async (profile) => {
      const snap = snapByUser.get(profile.user_id) ?? { status: "miss" as const };
      let lite: ResolvedCardLite[] | null = null;
      let available = 0;
      let completed = 0;
      if (snap.status === "hit" || (snap.status === "stale" && snap.cards.length > 0)) {
        lite = snapshotCardsToLite(snap.cards);
        for (const card of snap.cards) {
          if (card.isTransition) continue;
          available += card.growthDenominator;
          completed += card.growthNumerator;
        }
      } else if (snap.status === "error") {
        // DB 조회 실패(timeout 등) — 실시간 폴백 금지(무겁다). fail-soft 로 이 사용자 제외.
        failedUserIds.add(profile.user_id);
        return;
      }
      if (!lite) {
        // fallback: 실시간 계산(무겁다). miss(snapshot 없음 — 신규 유저)에만 탄다. 활동완료율은 0/0.
        // 폴백 자체가 실패해도 전체 배치를 깨지 않고 이 사용자만 제외(fail-soft).
        try {
          const g = await getWeeklyGrowth(profile.user_id);
          lite = (g?.weeklyCards ?? []).map((c) => ({
            resultStatus: c.resultStatus,
            startDate: c.startDate,
            endDate: c.endDate,
            isTransition: c.isTransition,
          }));
        } catch (e) {
          console.warn("[roster] realtime growth fallback failed → omit user", {
            userId: profile.user_id,
            message: e instanceof Error ? e.message : String(e),
          });
          failedUserIds.add(profile.user_id);
          return;
        }
      }
      liteByUser.set(profile.user_id, lite);
      activityByUser.set(profile.user_id, { available, completed });
  });

  const seasonKey = seasonKeyOverride !== undefined ? seasonKeyOverride : currentSeasonDbKey();
  return profiles
    .filter((profile) => !failedUserIds.has(profile.user_id))
    .map((profile) => {
    const internal = buildIndicators(
      profile,
      [],
      liteByUser.get(profile.user_id) ?? [],
      null,
      currentWeekMap.get(profile.user_id) ?? null,
      seasonsByUser.get(profile.user_id) ?? [],
      seasonKey,
      null,
    );
    const act = activityByUser.get(profile.user_id) ?? { available: 0, completed: 0 };
    const activityRate =
      act.available > 0 ? Math.round((act.completed / act.available) * 100) : 0;
    return {
      userId: profile.user_id,
      displayGrowthStatus: internal.process.growthDisplayKey,
      successWeeks: internal.period.a,
      growableWeeks: internal.period.e,
      activityAvailable: act.available,
      activityCompleted: act.completed,
      activityRate,
    };
  });
}

// ─── roster slim 캐시 우선 경로 (/admin/members 크루 목록) ───────────────
// getGrowthRosterBatch(=fat: 사용자별 snapshot fat cards 읽기)의 빠른 변형.
// cluster4_roster_card_stats(slim) 에서 a/e/h/activity 를 읽어 fat cards 전송을 회피하고,
// 표시 성장상태만 resolveGrowthStatusDetail(고객 동일 resolver)로 read-time 재계산한다(시즌휴식/
// 현재주/오버라이드 최신 반영). slim 은 writer 가 같은 snapshot 카드에서 파생·저장한 값이라
// fat 결과와 동일(a/e/activity)하며, snapshot_computed_at 일치 가드로 drift 를 차단한다.
//   - slim 무효(누락/버전불일치/computed_at 불일치/표 부재) 사용자 = getGrowthRosterBatch(fat)로 폴백.
//   → slim 이 비어 있거나 마이그레이션 미적용이어도 결과는 fat 와 동일(무중단·정합).
const ROSTER_STATS_TABLE = "cluster4_roster_card_stats";

type RosterSlimRow = {
  user_id: string;
  dto_version: number;
  snapshot_computed_at: string;
  success_weeks: number;
  growable_weeks: number;
  elapsed_weeks: number;
  activity_available: number;
  activity_completed: number;
};

export async function getGrowthRosterBatchFast(
  userIds: string[],
  // 시즌 키 override(미지정=현재 시즌). /admin/members 명부는 operationalSeasonDbKey 를 넘긴다.
  seasonKeyOverride?: string | null,
): Promise<GrowthRosterRow[]> {
  if (userIds.length === 0) return [];
  const ID_CHUNK = 200;

  // 1) slim 읽기(경량, cards 미포함). 표 부재(마이그레이션 미적용) 등 실패 시 전체 fat 폴백.
  const slimByUser = new Map<string, RosterSlimRow>();
  let slimAvailable = true;
  try {
    for (let i = 0; i < userIds.length; i += ID_CHUNK) {
      const chunk = userIds.slice(i, i + ID_CHUNK);
      const { data, error } = await supabaseAdmin
        .from(ROSTER_STATS_TABLE)
        .select(
          "user_id,dto_version,snapshot_computed_at,success_weeks,growable_weeks,elapsed_weeks,activity_available,activity_completed",
        )
        .in("user_id", chunk);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as RosterSlimRow[]) slimByUser.set(r.user_id, r);
    }
  } catch (e) {
    slimAvailable = false;
    console.warn("[roster-stats] slim read unavailable → fat fallback", {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // drift 가드: slim.snapshot_computed_at == 현재 snapshot.computed_at 인 행만 신뢰.
  const snapComputedAt = new Map<string, string>();
  if (slimAvailable && slimByUser.size > 0) {
    const slimIds = [...slimByUser.keys()];
    try {
      for (let i = 0; i < slimIds.length; i += ID_CHUNK) {
        const chunk = slimIds.slice(i, i + ID_CHUNK);
        // computed_at 만 SELECT(fat cards 미포함) — 경량. 단 실패 시 throw 하지 않고 slim 전체를
        // 무효화(→ fat 폴백)해 로스터 경로가 500 으로 깨지지 않게 한다(fail-soft).
        const { data, error } = await supabaseAdmin
          .from("cluster4_weekly_card_snapshots")
          .select("user_id,computed_at")
          .in("user_id", chunk);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as { user_id: string; computed_at: string }[]) {
          snapComputedAt.set(r.user_id, r.computed_at);
        }
      }
    } catch (e) {
      slimAvailable = false;
      snapComputedAt.clear();
      console.warn("[roster-stats] snapshot computed_at drift-guard read failed → fat fallback", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const slimValidIds: string[] = [];
  const needFatIds: string[] = [];
  for (const uid of userIds) {
    const s = slimByUser.get(uid);
    if (
      s &&
      s.dto_version === WEEKLY_CARDS_DTO_VERSION &&
      snapComputedAt.get(uid) === s.snapshot_computed_at
    ) {
      slimValidIds.push(uid);
    } else {
      needFatIds.push(uid);
    }
  }

  const out: GrowthRosterRow[] = [];

  // 2) fat 폴백(미백필/불일치/누락) — 기존 검증된 경로 그대로(override 전달).
  if (needFatIds.length > 0) {
    out.push(...(await getGrowthRosterBatch(needFatIds, seasonKeyOverride)));
  }

  // 3) slim 경로 — a/e/h/activity=slim, 상태=resolveGrowthStatusDetail(buildIndicators 동일 입력).
  if (slimValidIds.length > 0) {
    const [profileRes, seasonRes, currentWeekMap] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,growth_status,activity_started_at,activity_ended_at,organization_slug")
        .in("user_id", slimValidIds),
      supabaseAdmin
        .from("user_season_statuses")
        .select("user_id,status,season_key")
        .in("user_id", slimValidIds),
      fetchCurrentWeekStatusBatch(slimValidIds),
    ]);
    if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
    if (seasonRes.error) throw new GrowthError(500, seasonRes.error.message);

    const profiles = (profileRes.data ?? []) as ProfileRow[];
    const seasonsByUser = new Map<string, SeasonStatusRow[]>();
    for (const row of (seasonRes.data ?? []) as (SeasonStatusRow & { user_id: string })[]) {
      const list = seasonsByUser.get(row.user_id!) ?? [];
      list.push(row);
      seasonsByUser.set(row.user_id!, list);
    }
    const seasonKey = seasonKeyOverride !== undefined ? seasonKeyOverride : currentSeasonDbKey();

    for (const profile of profiles) {
      const s = slimByUser.get(profile.user_id)!;
      const org = profile.organization_slug;
      const orgValid = org && isOrganizationSlug(org) ? (org as OrganizationSlug) : null;
      const threshold = orgValid ? getGraduationThreshold(orgValid) : null;
      const seasonRows = seasonsByUser.get(profile.user_id) ?? [];
      const seasonRestActive =
        seasonKey !== null &&
        seasonRows.some((sr) => sr.status === "rest" && sr.season_key === seasonKey);
      const seasonStoppedActive =
        seasonKey !== null &&
        seasonRows.some((sr) => sr.status === "stopped" && sr.season_key === seasonKey);
      const display = resolveGrowthStatusDetail({
        growthStatus: profile.growth_status,
        seasonRestActive,
        seasonStoppedActive,
        currentWeekStatus: currentWeekMap.get(profile.user_id) ?? null,
        approvedWeeks: s.success_weeks,
        elapsedWeeks: s.elapsed_weeks,
        graduationThreshold: threshold,
      }).display;
      out.push({
        userId: profile.user_id,
        displayGrowthStatus: display,
        successWeeks: s.success_weeks,
        growableWeeks: s.growable_weeks,
        activityAvailable: s.activity_available,
        activityCompleted: s.activity_completed,
        activityRate: rosterActivityRate(s.activity_available, s.activity_completed),
      });
    }

    // 프로필 행이 없는 slim 사용자(이론상 드묾) — fat 폴백으로 보강.
    const gotProfiles = new Set(profiles.map((p) => p.user_id));
    const missing = slimValidIds.filter((id) => !gotProfiles.has(id));
    if (missing.length > 0) out.push(...(await getGrowthRosterBatch(missing)));
  }

  return out;
}
