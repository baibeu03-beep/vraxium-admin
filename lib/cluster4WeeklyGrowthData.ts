import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  getSeasonForDate,
  getSeasonCalendar,
  getCalendarWeekStatus,
  isTransitionWeekStart,
  seasonDbKey,
  type Season,
} from "@/lib/seasonCalendar";
import { getGraduationThreshold } from "@/lib/pointLabels";
import {
  fetchActiveRestPeriods,
  isSeasonRuleRestForWeekStart,
} from "@/lib/officialRestPeriodsData";
import {
  matchOfficialRestPeriods,
  periodTypeToRestReason,
} from "@/lib/officialRestPeriodsTypes";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  WEEK_STATUS_LABEL,
  formatDateRange,
  type WeeklyGrowthDto,
  type WeeklyGrowthStatus,
  type WeeklyCardDto,
  type WeeklyCardLineBreakdown,
  type ExperienceGrowthVerdictDto,
  type WeekResultStatus,
  type CurrentWeekInfo,
  type GrowthSummary,
  type SeasonGrowthRate,
  type RestReason,
  type EndStatus,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  fetchWeeklyCardLineAggregates,
  fetchExperienceRequiredSlotStatusByWeek,
  shouldApplyExperienceFail,
  shouldSyncWeekStatusToFail,
  buildWeekAvailability,
  roundGrowthRate,
  type ExperienceGrowthVerdict,
} from "@/lib/lineAvailability";

// ─────────────────────────────────────────────────────────────────────
// Date/week utilities
// ─────────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

function toMs(iso: string): number {
  return Date.UTC(
    +iso.slice(0, 4),
    +iso.slice(5, 7) - 1,
    +iso.slice(8, 10),
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function getWeekInSeason(
  season: Season,
  dateIso: string,
): { weekNumber: number; weekStart: string; weekEnd: string } {
  const seasonStartMs = toMs(season.startDate);
  const dateMs = toMs(dateIso);
  const dayOffset = Math.floor((dateMs - seasonStartMs) / DAY_MS);
  const weekIndex = Math.floor(dayOffset / 7);
  const weekNumber = weekIndex + 1;
  const weekStartMs = seasonStartMs + weekIndex * 7 * DAY_MS;
  const weekEndMs = weekStartMs + 6 * DAY_MS;
  return {
    weekNumber,
    weekStart: fmtDate(weekStartMs),
    weekEnd: fmtDate(weekEndMs),
  };
}

function seasonDisplayName(season: Season): string {
  return `${season.type} 시즌`;
}

function getNextSeason(current: Season): Season | null {
  const cal = getSeasonCalendar(current.year);
  const idx = cal.findIndex(
    (s) => s.type === current.type && s.year === current.year,
  );
  if (idx >= 0 && idx < cal.length - 1) return cal[idx + 1];
  const nextYearCal = getSeasonCalendar(current.year + 1);
  return nextYearCal[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Compute current week info
// ─────────────────────────────────────────────────────────────────────
async function computeCurrentWeekInfo(): Promise<CurrentWeekInfo> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const season = getSeasonForDate(todayIso);

  if (!season) {
    return {
      year: new Date().getUTCFullYear(),
      seasonName: "봄 시즌",
      weekNumber: 1,
      startDate: todayIso,
      endDate: todayIso,
      status: "running",
      restReason: null,
      nextSeasonName: null,
    };
  }

  const { weekNumber, weekStart, weekEnd } = getWeekInSeason(season, todayIso);

  const calendarStatus = getCalendarWeekStatus(
    season.type,
    weekNumber,
    season.seasonWeeks,
  );

  let status: WeeklyGrowthStatus;
  let restReason: RestReason = null;
  let nextSeasonName: string | null = null;

  if (calendarStatus === "transition") {
    status = "transition";
    restReason = "transition";
    const next = getNextSeason(season);
    nextSeasonName = next ? seasonDisplayName(next) : null;
  } else if (calendarStatus === "official_rest") {
    // 시험기간(seasonCalendar 규칙). 별도 사유 없음.
    status = "official_rest";
    restReason = null;
  } else {
    // 설/추석/임시 휴식 — official_rest_periods 날짜 overlap 으로 판정.
    const matched = matchOfficialRestPeriods(
      { startDate: weekStart, endDate: weekEnd },
      await fetchActiveRestPeriods(),
    );
    if (matched.length > 0) {
      status = "official_rest";
      restReason = periodTypeToRestReason(matched[0].type);
    } else {
      status = "running";
    }
  }

  return {
    year: season.year,
    seasonName: seasonDisplayName(season),
    weekNumber,
    startDate: weekStart,
    endDate: weekEnd,
    status,
    restReason,
    nextSeasonName,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Compute growth summary for a user
// ─────────────────────────────────────────────────────────────────────
async function computeGrowthSummary(userId: string): Promise<GrowthSummary> {
  const [weekRes, profileRes, seasonStatusRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("year,week_number,status,season_key,week_start_date")
      .eq("user_id", userId)
      .order("year", { ascending: true })
      .order("week_number", { ascending: true }),
    supabaseAdmin
      .from("user_profiles")
      .select("activity_started_at,activity_ended_at,growth_status")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_season_statuses")
      .select("status")
      .eq("user_id", userId)
      .eq("status", "rest"),
  ]);

  if (weekRes.error || !weekRes.data || profileRes.error) {
    return emptyGrowthSummary();
  }

  type WeekRow = {
    year: number;
    week_number: number;
    status: string;
    season_key: string | null;
    week_start_date: string | null;
  };
  const weeks = weekRes.data as WeekRow[];

  if (weeks.length === 0) return emptyGrowthSummary();

  let approvedWeeks = 0;
  let failedWeeks = 0;
  let restWeeks = 0;

  for (const w of weeks) {
    // 전환 주차는 성장 요약(분자·분모) 집계에서 제외(공식 휴식 아님).
    if (w.week_start_date && isTransitionWeekStart(w.week_start_date)) continue;
    switch (w.status) {
      case "success":
        approvedWeeks++;
        break;
      case "fail":
        failedWeeks++;
        break;
      case "personal_rest":
        restWeeks++;
        break;
    }
  }

  const availableWeeks = approvedWeeks + failedWeeks + restWeeks;

  const restSeasonCount =
    !seasonStatusRes.error && seasonStatusRes.data
      ? (seasonStatusRes.data as Array<unknown>).length
      : 0;

  const first = weeks[0];
  const startWeekDisplay = `${first.year}년, ${first.week_number}주차`;

  const profileData = profileRes.data as {
    activity_started_at: string | null;
    activity_ended_at: string | null;
    growth_status: string | null;
  } | null;

  let endStatus: EndStatus = "in_progress";
  let endWeekDisplay = "~ing (성장 진행 중)";

  if (profileData?.growth_status === "graduated") {
    endStatus = "completed";
    const last = weeks[weeks.length - 1];
    const seasonLabel = last.season_key
      ? formatSeasonKeyToLabel(last.season_key)
      : "";
    endWeekDisplay = seasonLabel
      ? `${last.year}년, ${seasonLabel}, ${last.week_number}주차(성장 완료)`
      : `${last.year}년, ${last.week_number}주차(성장 완료)`;
  } else if (
    profileData?.growth_status === "suspended" ||
    profileData?.growth_status === "paused"
  ) {
    endStatus = "stopped";
    const last = weeks[weeks.length - 1];
    const seasonLabel = last.season_key
      ? formatSeasonKeyToLabel(last.season_key)
      : "";
    endWeekDisplay = seasonLabel
      ? `${last.year}년, ${seasonLabel}, ${last.week_number}주차(성장 중단)`
      : `${last.year}년, ${last.week_number}주차(성장 중단)`;
  }

  return {
    startWeekDisplay,
    availableWeeks,
    approvedWeeks,
    failedWeeks,
    restWeeks,
    restSeasonCount,
    endWeekDisplay,
    endStatus,
  };
}

function formatSeasonKeyToLabel(key: string): string {
  const typeMap: Record<string, string> = {
    spring: "봄 시즌",
    summer: "여름 시즌",
    autumn: "가을 시즌",
    winter: "겨울 시즌",
  };
  const parts = key.split("-");
  if (parts.length === 2) {
    return typeMap[parts[1]] ?? "";
  }
  return "";
}

function emptyGrowthSummary(): GrowthSummary {
  return {
    startWeekDisplay: "-",
    availableWeeks: 0,
    approvedWeeks: 0,
    failedWeeks: 0,
    restWeeks: 0,
    restSeasonCount: 0,
    endWeekDisplay: "~ing (성장 진행 중)",
    endStatus: "in_progress",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Weekly Cards: 실제 DB 기반 주차 카드 목록
// ─────────────────────────────────────────────────────────────────────

type UwsRow = {
  year: number;
  week_number: number;
  week_start_date: string;
  status: string;
  season_key: string | null;
};

type WeeksRow = {
  id: string;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  is_official_rest: boolean;
  holiday_name: string | null;
  iso_year: number | null;
  iso_week: number | null;
  // 집계/공표 완료 시점. NULL=미공표(집계 중), 값 존재=공표 완료(success/fail 노출).
  result_published_at: string | null;
};

type PointsRow = {
  year: number;
  week_number: number;
  points: number;
  advantages: number;
  penalty: number;
};

type CrewMetadata = {
  teamLabel: string;
  partLabel: string;
  activityStatus: string;
  teamNameRaw: string | null;
  partNameRaw: string | null;
  roleLabelRaw: string | null;
  membershipStatusLabelRaw: string | null;
  organizationSlug: string | null;
};

async function computeWeeklyCards(
  userId: string,
  organization: OrganizationSlug | null,
  crewMeta: CrewMetadata,
): Promise<{ cards: WeeklyCardDto[]; flippedToFail: number }> {
  const { teamLabel, partLabel, activityStatus } = crewMeta;
  // 1. 사용자 주차 상태 조회 (보조 데이터). 카드 루프의 기준은 weeks 이며, uws 는 있으면 붙인다.
  const { data: uwsData, error: uwsErr } = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false });

  if (uwsErr || !uwsData || uwsData.length === 0) {
    // 활동 이력(uws)이 전혀 없으면 표시할 궤적이 없다 → 기존과 동일하게 빈 목록.
    return { cards: [], flippedToFail: 0 };
  }
  const uwsRows = uwsData as UwsRow[];
  // week_start_date → uws (보조 데이터 lookup). 카드 주차에 붙인다.
  const uwsByStart = new Map<string, UwsRow>();
  for (const r of uwsRows) uwsByStart.set(r.week_start_date, r);

  // 공식 휴식 재판정용 — 활성 official_rest_periods 를 1회 prefetch 하여
  // 루프 안에서 주차별로 seasonCalendar rule ∨ 날짜 overlap 으로 판정한다.
  const activeRestPeriods = await fetchActiveRestPeriods();

  // 2. 현재 시즌/주차 판별 (카드 범위 상한 + running/official_rest 판정).
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentSeason = getSeasonForDate(todayIso);
  const currentWeek = currentSeason
    ? getWeekInSeason(currentSeason, todayIso)
    : null;
  const currentWeekStart = currentWeek?.weekStart ?? null;

  // 3. 카드 대상 weeks 범위: [가장 이른 uws 주차, 현재 주차]. 현재 주차가 없으면 최신 uws 까지.
  //    미래 주차(현재 주차 이후)는 제외한다.
  const uwsStartsSorted = uwsRows.map((r) => r.week_start_date).sort();
  const lowerBound = uwsStartsSorted[0];
  const latestUwsStart = uwsStartsSorted[uwsStartsSorted.length - 1];
  const upperBound = currentWeekStart
    ? currentWeekStart > latestUwsStart
      ? currentWeekStart
      : currentWeekStart
    : latestUwsStart;

  // 4. 범위 내 weeks 조회 — 카드 루프의 기준 source (uws 가 아니라 weeks 가 카드를 만든다).
  const { data: weeksData } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,iso_year,iso_week,result_published_at")
    .gte("start_date", lowerBound)
    .lte("start_date", upperBound)
    .order("start_date", { ascending: false });

  const weeksByDate = new Map<string, WeeksRow>();
  for (const w of (weeksData ?? []) as WeeksRow[]) {
    if (w.start_date) weeksByDate.set(w.start_date, w);
  }

  // 5. 카드 대상 주차 집합 = 범위 내 weeks ∪ (weeks row 가 없는 orphan uws 합성).
  //    orphan uws(예: 2025-09): weeks 테이블에 대응 row 가 없던 과거 주차. 카드가 사라지지 않도록
  //    합성 주차로 포함하고, 공표 개념 도입 전 데이터이므로 "공표 완료"로 취급해 기존 표시(uws.status)를 보존한다.
  type CardWeek = {
    id: string | null;
    week_number: number | null;
    start_date: string;
    end_date: string | null;
    season_key: string | null;
    iso_year: number | null;
    iso_week: number | null;
    result_published_at: string | null;
    synthetic: boolean;
  };
  const cardWeekByStart = new Map<string, CardWeek>();
  for (const w of weeksByDate.values()) {
    if (!w.start_date) continue;
    cardWeekByStart.set(w.start_date, {
      id: w.id,
      week_number: w.week_number,
      start_date: w.start_date,
      end_date: w.end_date,
      season_key: w.season_key,
      iso_year: w.iso_year,
      iso_week: w.iso_week,
      result_published_at: w.result_published_at,
      synthetic: false,
    });
  }
  for (const r of uwsRows) {
    if (cardWeekByStart.has(r.week_start_date)) continue;
    // orphan uws → 합성 주차 (id 없음 → 라인/포인트-by-id 맵에서 자동 제외, 기존 동작과 동일).
    cardWeekByStart.set(r.week_start_date, {
      id: null,
      week_number: null, // displayWeekNum 은 uws.week_number(iso) 로 폴백
      start_date: r.week_start_date,
      end_date: null,
      season_key: r.season_key,
      iso_year: r.year,
      iso_week: r.week_number,
      result_published_at: null,
      synthetic: true,
    });
  }
  // 최신순(내림차순) 카드 출력 / 오름차순은 누적 계산용.
  const cardWeeksDesc = [...cardWeekByStart.values()].sort((a, b) =>
    a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0,
  );
  const cardWeeksAsc = [...cardWeeksDesc].reverse();

  // 합성(orphan)은 공표 완료로 취급 — 공표 개념 도입 전 과거 데이터의 기존 표시 보존.
  const isWeekPublished = (w: CardWeek): boolean =>
    Boolean(w.result_published_at) || w.synthetic;
  const isCurrentWeekStart = (start: string): boolean =>
    currentWeekStart != null && start === currentWeekStart;

  // 6. season_definitions 라벨 (카드 주차들의 season_key 기준).
  const seasonKeys = [
    ...new Set(
      cardWeeksDesc.map((w) => w.season_key).filter(Boolean) as string[],
    ),
  ];
  type SeasonDefRow = { season_key: string; season_label: string; year: number };
  const seasonLabelMap = new Map<string, SeasonDefRow>();
  if (seasonKeys.length > 0) {
    const { data: sdData } = await supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,year")
      .in("season_key", seasonKeys);
    if (sdData) {
      for (const sd of sdData as SeasonDefRow[]) {
        seasonLabelMap.set(sd.season_key, sd);
      }
    }
  }

  // 7. 주차별 포인트 조회 (iso year/week 키).
  const { data: pointsData } = await supabaseAdmin
    .from("user_weekly_points")
    .select("year,week_number,points,advantages,penalty")
    .eq("user_id", userId);

  const pointsMap = new Map<string, PointsRow>();
  if (pointsData) {
    for (const p of pointsData as PointsRow[]) {
      pointsMap.set(`${p.year}-${p.week_number}`, p);
    }
  }

  // 8. 평판/동료/라인/verdict 맵 (weeks.id 기준 — 합성 주차는 id 없어 자동 제외).
  const weekCardIds = cardWeeksDesc
    .map((w) => w.id)
    .filter((id): id is string => Boolean(id));
  const repCountMap = new Map<string, number>();
  if (weekCardIds.length > 0) {
    const { data: repData } = await supabaseAdmin
      .from("weekly_reputations")
      .select("week_card_id")
      .eq("target_user_id", userId)
      .in("week_card_id", weekCardIds);
    if (repData) {
      for (const r of repData as { week_card_id: string }[]) {
        repCountMap.set(r.week_card_id, (repCountMap.get(r.week_card_id) ?? 0) + 1);
      }
    }
  }

  // 5. 주차별 연계 동료 카운트
  const colCountMap = new Map<string, number>();
  if (weekCardIds.length > 0) {
    const { data: colData } = await supabaseAdmin
      .from("weekly_colleagues")
      .select("week_card_id")
      .eq("user_id", userId)
      .in("week_card_id", weekCardIds);
    if (colData) {
      for (const c of colData as { week_card_id: string }[]) {
        colCountMap.set(c.week_card_id, (colCountMap.get(c.week_card_id) ?? 0) + 1);
      }
    }
  }

  // 6. 주차별 강화율 분자 B = part별 (배정 target 중 마감 지난) success 수 + 가용 라인 수.
  // 4개 part 모두 동일 기준: target + submission_closes_at 마감, 제출 무관 (강화상태 success 와 동일).
  // user_activity_details 미사용 (구 source 제거, target+마감 기준으로 통일).
  let infoLineMap = new Map<string, number>();
  let experienceLineMap = new Map<string, number>();
  let competencyLineMap = new Map<string, number>();
  let infoSuccessMap = new Map<string, number>();
  let abilitySuccessMap = new Map<string, number>();
  let experienceSuccessMap = new Map<string, number>();
  let careerSuccessMap = new Map<string, number>();
  // P1: 사용자 배정 career 라인 수(분모 A). (구: career_project_weeks 프로젝트 개설 수)
  let careerLineMap = new Map<string, number>();
  // 실무 경험 필수 슬롯(도출/분석/평가) verdict: weekId → verdict. (강화율/평점/5슬롯 로직과 독립)
  let experienceVerdictMap = new Map<string, ExperienceGrowthVerdict>();

  if (weekCardIds.length > 0) {
    // 기존 9개 fetch* (cluster4_lines 9회 + cluster4_line_targets 8회 ≈ 17~20 쿼리) 를
    // bulk aggregate(최대 3쿼리) + verdict(최대 3쿼리) = 최대 6쿼리로 축소.
    const tLines = Date.now();
    const [aggregates, experienceVerdict] = await Promise.all([
      fetchWeeklyCardLineAggregates(userId, weekCardIds),
      // 필수 슬롯 verdict (성장 실패 판정 SoT). 강화율 분자/분모와 별개 source.
      fetchExperienceRequiredSlotStatusByWeek(userId, weekCardIds),
    ]);
    console.log(
      "[weekly-cards][timing] line aggregates+verdict",
      `${Date.now() - tLines}ms`,
      `| weeks=${weekCardIds.length}`,
    );

    infoLineMap = aggregates.infoLineMap;
    experienceLineMap = aggregates.experienceLineMap;
    competencyLineMap = aggregates.competencyLineMap;
    infoSuccessMap = aggregates.infoSuccessMap;
    abilitySuccessMap = aggregates.abilitySuccessMap;
    experienceSuccessMap = aggregates.experienceSuccessMap;
    careerSuccessMap = aggregates.careerSuccessMap;
    careerLineMap = aggregates.careerLineMap;
    experienceVerdictMap = experienceVerdict;
  }

  // 9. 누적 계산 (오름차순) — 카드 주차 기준, start_date 키.
  //    확정 누적 = "공표 완료된 DB success" 만 센다. 현재주(진행 중)·미공표 주차(집계 중)·
  //    uws 없는 주차는 확정 전/대상 아님이므로 제외 → 카드의 +1 프리뷰가 더할 base (정책 5).
  //    필수 슬롯 verdict=fail 이면 success 에서 제외 → 배지·누적·요약 일관성 유지.
  let cumulativeSuccess = 0;
  const accByStart = new Map<string, number>();
  for (const w of cardWeeksAsc) {
    const uws = uwsByStart.get(w.start_date);
    const verdict = w.id ? experienceVerdictMap.get(w.id) : undefined;
    const isCurrent = isCurrentWeekStart(w.start_date);
    const published = isWeekPublished(w);
    let countsAsSuccess =
      uws?.status === "success" && published && !isCurrent;
    if (countsAsSuccess && verdict?.status === "fail") {
      countsAsSuccess = false;
    }
    if (countsAsSuccess) cumulativeSuccess++;
    accByStart.set(w.start_date, cumulativeSuccess);
  }

  // 누적 포인트 (FM score proxy). Null when no points row exists for this week
  // AND no prior week contributed — distinguishes "no data" from "real 0".
  let cumulativePoints = 0;
  let cumulativeAdvantages = 0;
  let anyPointsSeen = false;
  let anyAdvantagesSeen = false;
  const fmByStart = new Map<string, number | null>();
  const cumAdvByStart = new Map<string, number | null>();
  for (const w of cardWeeksAsc) {
    const p = pointsMap.get(`${w.iso_year}-${w.iso_week}`);
    if (p) {
      cumulativePoints += p.points + p.advantages * 3 - p.penalty * 5;
      cumulativeAdvantages += p.advantages;
      anyPointsSeen = true;
      anyAdvantagesSeen = true;
    }
    fmByStart.set(w.start_date, anyPointsSeen ? cumulativePoints : null);
    cumAdvByStart.set(
      w.start_date,
      anyAdvantagesSeen ? cumulativeAdvantages : null,
    );
  }

  const targetWeeks = organization
    ? getGraduationThreshold(organization)
    : 30;

  // 9. 카드 조립 (최신순)
  const cards: WeeklyCardDto[] = [];
  // DB success → 필수 슬롯 verdict=fail 로 전환된 주차 수 (요약 approved/failed 보정용).
  let flippedToFail = 0;

  for (const week of cardWeeksDesc) {
    const startDate = week.start_date;
    // uws 는 보조 데이터 — 있으면 붙이고, 없으면 weeks 기준 기본 상태로 카드를 만든다.
    const uws = uwsByStart.get(startDate) ?? null;
    const weekCardId = week.id;
    const pts = pointsMap.get(`${week.iso_year}-${week.iso_week}`);

    // 시즌 정보 결정 (season_definitions.season_label 우선). 기준은 weeks.season_key.
    const seasonKey = week.season_key ?? uws?.season_key ?? null;
    const seasonDef = seasonKey ? seasonLabelMap.get(seasonKey) : null;
    const seasonYear =
      seasonDef?.year ??
      week.iso_year ??
      uws?.year ??
      new Date().getUTCFullYear();
    const seasonName = seasonDef
      ? seasonDef.season_label
      : seasonKey
        ? formatSeasonKeyToLabel(seasonKey)
        : "";

    // 시즌 내 주차 번호 (weeks.week_number 우선, 합성주차는 uws.week_number(iso) 폴백).
    const seasonWeekNumber = week.week_number ?? null;

    // 주차 종료일 (weeks.end_date 우선, 없으면 start+6).
    const endDateMs = toMs(startDate) + 6 * DAY_MS;
    const endDate = week.end_date ?? fmtDate(endDateMs);

    // 공식 휴식 여부(신규 SoT): seasonCalendar rule ∨ official_rest_periods overlap.
    // weeks.is_official_rest 는 더 이상 참조하지 않는다.
    const weekIsOfficialRest =
      isSeasonRuleRestForWeekStart(startDate) ||
      matchOfficialRestPeriods({ startDate, endDate }, activeRestPeriods).length >
        0;

    // ── 상태 결정 (6종 + no_data skip) — 기준은 weeks, uws 는 보조 ──
    // 정책:
    //   1) 현재 주차 → 공식 휴식이면 휴식(공식), uws=개인휴식이면 휴식(개인), 그 외 진행 중(running).
    //   2) uws 존재(과거/직전) → 기존 로직 그대로 보존 (공표 전 성장주차는 집계 중 등).
    //   3) uws 없음 → 공식 휴식이면 휴식(공식), 미공표면 집계 중, 공표완료면 no_data(카드 미생성).
    //   ⚠ tallying / no_data 모두 read-time 판정 — DB(user_week_statuses)는 건드리지 않는다.
    const isCurrentWeek = isCurrentWeekStart(startDate);
    const isPublished = isWeekPublished(week);
    let resultStatus: WeekResultStatus;

    if (isCurrentWeek) {
      // 현재 주차는 결과 확정 전이므로 항상 진행 중 — 단, 휴식 주차는 휴식으로 표시.
      resultStatus = weekIsOfficialRest
        ? "official_rest"
        : uws?.status === "personal_rest"
          ? "personal_rest"
          : "running";
    } else if (uws) {
      // ── uws 존재: 기존 표시 로직 100% 보존 (과거/직전 카드 불변) ──
      if (uws.status === "official_rest" && !weekIsOfficialRest) {
        // 공식 휴식으로 기록됐으나 재판정상 활동 주차 → 성장 주차로 간주.
        resultStatus = isPublished ? "fail" : "tallying";
      } else if (
        uws.status === "personal_rest" ||
        uws.status === "official_rest"
      ) {
        resultStatus = uws.status as WeekResultStatus;
      } else if (!isPublished) {
        // 성장 주차(success/fail) + 미공표 → 집계 중.
        resultStatus = "tallying";
      } else {
        resultStatus = uws.status as WeekResultStatus;
      }
    } else {
      // ── uws 없음 (비-현재주): weeks 기준 기본 상태 ──
      //   - 미공표 → 집계 중 (참여했으나 uws 미생성 가능성 — 직전/최근 주차).
      //   - 공표완료 → no_data 정책: 카드 미생성(skip). 공식 휴식이라도 uws 가 없으면
      //     해당 주차에 참여 기록이 없는 것이므로(늦은 합류/시즌 휴식) 날조하지 않고 카드 없음.
      //     기존(uws 기준) 동작과 동일하게 과거 비참여 주차는 카드가 없다.
      //     (현재 주차의 공식 휴식은 위 isCurrentWeek 분기에서 uws 없이도 official_rest 로 노출.)
      //   ⚠ fail 로 보고 싶다면 아래 continue 를 resultStatus = "fail" 로 바꾸면 된다.
      if (!isPublished) {
        resultStatus = "tallying";
      } else {
        continue;
      }
    }

    // ── 실무 경험 필수 슬롯(도출/분석/평가) verdict 반영 (read-time override) ──
    // verdict=fail 이면 (휴식/진행=현재주 제외) 주차 성장 상태를 fail 로 확정한다.
    // 강화율/평점/5슬롯/info 로직은 건드리지 않는다 (별개 source).
    //
    // ⚠ 운영 주의(SoT 정책): 이 override 는 "sync 전 갭 보정용"이다.
    //   SoT = user_week_statuses.status. sync(syncExperienceGrowthWeekStatuses)가
    //   DB 에 fail 을 영속화하기 전까지는, 같은 주차가 cluster4(weekly-cards)에서는
    //   override 로 '성장(실패)'로 보이지만 cluster1(이력서)·cluster3(성장지표)는
    //   raw DB status(=success)를 읽으므로 '성공'으로 집계될 수 있다(일시적 불일치).
    //   sync 로 DB=fail 이 되면 이 override 는 no-op 이 되고 세 클러스터가 일치한다.
    //   cluster1/cluster3 에는 override 를 추가하지 않는다(정책).
    const experienceVerdict = weekCardId
      ? experienceVerdictMap.get(weekCardId)
      : undefined;
    const baseStatusBeforeVerdict = resultStatus;
    if (
      experienceVerdict &&
      shouldApplyExperienceFail(experienceVerdict.status, resultStatus)
    ) {
      resultStatus = "fail";
    }
    if (baseStatusBeforeVerdict === "success" && resultStatus === "fail") {
      flippedToFail++;
    }
    const experienceGrowth: ExperienceGrowthVerdictDto = experienceVerdict
      ? {
          status: experienceVerdict.status,
          requiredSlots: experienceVerdict.requiredSlots.map((s) => ({
            slotOrder: s.slotOrder,
            category: s.category,
            enhancementStatus: s.enhancementStatus,
          })),
          failedSlotOrders: experienceVerdict.failedSlotOrders,
          appliedToWeekStatus:
            experienceVerdict.status === "fail" && resultStatus === "fail",
        }
      : {
          status: "not_applicable",
          requiredSlots: [],
          failedSlotOrders: [],
          appliedToWeekStatus: false,
        };

    const isRest =
      resultStatus === "personal_rest" ||
      resultStatus === "official_rest";

    // 라인 가용 수(A)는 동적 조회. 이행 수(B): info/ability/experience 는 target+마감 기준,
    // career(P1)는 target+마감+grade C이상 기준(평점 반영 — per-line enhancementStatus 와 일치).
    const avail = isRest
      ? { info: 0, ability: 0, experience: 0, career: 0 }
      : buildWeekAvailability(
          weekCardId,
          infoLineMap,
          // careerMap(레거시 project 기반)은 미사용. career A 는 careerUserMap(per-user)로 전달.
          new Map<string, number>(),
          organization,
          experienceLineMap,
          competencyLineMap,
          careerLineMap,
        );

    const lineBreakdown: WeeklyCardLineBreakdown = {
      // info/ability/experience B = target+마감 success(제출 무관). career B = target+마감+grade C이상(P1).
      info: { completed: isRest ? 0 : (weekCardId ? (infoSuccessMap.get(weekCardId) ?? 0) : 0), available: avail.info },
      ability: { completed: isRest ? 0 : (weekCardId ? (abilitySuccessMap.get(weekCardId) ?? 0) : 0), available: avail.ability },
      experience: { completed: isRest ? 0 : (weekCardId ? (experienceSuccessMap.get(weekCardId) ?? 0) : 0), available: avail.experience },
      career: { completed: isRest ? 0 : (weekCardId ? (careerSuccessMap.get(weekCardId) ?? 0) : 0), available: avail.career },
    };

    const completedLines =
      lineBreakdown.info.completed +
      lineBreakdown.ability.completed +
      lineBreakdown.experience.completed +
      lineBreakdown.career.completed;
    const availableLines =
      lineBreakdown.info.available +
      lineBreakdown.ability.available +
      lineBreakdown.experience.available +
      lineBreakdown.career.available;
    const rate = roundGrowthRate(completedLines, availableLines);

    const displayWeekNum =
      seasonWeekNumber ?? uws?.week_number ?? week.iso_week ?? 0;

    const fmRaw = fmByStart.get(startDate) ?? null;
    const cumAdvRaw = cumAdvByStart.get(startDate) ?? null;
    const repCountRaw = weekCardId ? (repCountMap.get(weekCardId) ?? 0) : null;
    const colCountRaw = weekCardId ? (colCountMap.get(weekCardId) ?? 0) : null;

    cards.push({
      weekId: weekCardId,
      seasonYear,
      seasonName,
      seasonKey,
      weekNumber: displayWeekNum,
      startDate,
      endDate,
      dateRangeDisplay: formatDateRange(startDate, endDate),
      resultStatus,
      resultLabel: WEEK_STATUS_LABEL[resultStatus] ?? resultStatus,
      isTransition: isTransitionWeekStart(startDate),
      accumulatedApprovedWeeks: accByStart.get(startDate) ?? 0,
      targetWeeks,
      activityStatus,
      teamLabel,
      partLabel,
      teamNameRaw: crewMeta.teamNameRaw,
      partNameRaw: crewMeta.partNameRaw,
      roleLabelRaw: crewMeta.roleLabelRaw,
      membershipStatusLabelRaw: crewMeta.membershipStatusLabelRaw,
      organizationSlug: crewMeta.organizationSlug,
      points: pts?.points ?? 0,
      advantages: pts?.advantages ?? 0,
      penalty: pts?.penalty ?? 0,
      pointsRaw: pts ? pts.points : null,
      advantagesRaw: pts ? pts.advantages : null,
      penaltyRaw: pts ? pts.penalty : null,
      cumulativeAdvantages: cumAdvRaw,
      weeklyReputationCount: repCountRaw ?? 0,
      weeklyReputationCountRaw: repCountRaw,
      totalFmScore: fmRaw ?? 0,
      totalFmScoreRaw: fmRaw,
      linkedCrewCount: colCountRaw ?? 0,
      linkedCrewCountRaw: colCountRaw,
      weekImagePath: seasonKey
        ? `/images/0/cluster4/weekly/${seasonKey}-week${displayWeekNum}.png`
        : "",
      weeklyGrowth: { completedLines, availableLines, rate },
      lineBreakdown,
      experienceGrowth,
    });
  }

  return { cards, flippedToFail };
}

// ─────────────────────────────────────────────────────────────────────
// 시즌 성장률: 주차별 평균이 아니라 시즌 전체 합산 기반
//   rate = ceil(totalCompleted / totalAvailable × 100)
// ─────────────────────────────────────────────────────────────────────
function computeSeasonGrowthRates(cards: WeeklyCardDto[]): SeasonGrowthRate[] {
  const map = new Map<string, { label: string; completed: number; available: number }>();

  for (const c of cards) {
    if (!c.seasonKey) continue;
    // 전환 주차는 시즌 성장률(분자·분모)에서 제외.
    if (c.isTransition) continue;
    if (!map.has(c.seasonKey)) {
      map.set(c.seasonKey, { label: c.seasonName, completed: 0, available: 0 });
    }
    const s = map.get(c.seasonKey)!;
    s.completed += c.weeklyGrowth.completedLines;
    s.available += c.weeklyGrowth.availableLines;
  }

  return [...map.entries()].map(([key, v]) => ({
    seasonKey: key,
    seasonLabel: v.label,
    totalCompleted: v.completed,
    totalAvailable: v.available,
    rate: roundGrowthRate(v.completed, v.available),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Main: Weekly Growth DTO (카드 포함)
// ─────────────────────────────────────────────────────────────────────
export async function getWeeklyGrowth(
  legacyUserId: string,
): Promise<WeeklyGrowthDto | null> {
  const t0 = Date.now();
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return null;
  const tCrew = Date.now();

  const currentWeekInfo = await computeCurrentWeekInfo();

  if (!crew.userId) {
    return {
      currentWeekInfo,
      growthSummary: emptyGrowthSummary(),
      weeklyCards: [],
      seasonGrowthRates: [],
    };
  }

  const tCurrentWeek = Date.now();
  const [growthSummary, weeklyResult] = await Promise.all([
    computeGrowthSummary(crew.userId),
    computeWeeklyCards(
      crew.userId,
      (crew.organizationSlug as OrganizationSlug) ?? null,
      {
        teamLabel: crew.teamName ?? "-",
        partLabel: crew.partName ?? "-",
        activityStatus: crew.membershipLevel ?? "일반",
        teamNameRaw: crew.teamName ?? null,
        partNameRaw: crew.partName ?? null,
        roleLabelRaw: crew.membershipLevel ?? null,
        membershipStatusLabelRaw: crew.membershipState ?? null,
        organizationSlug: crew.organizationSlug ?? null,
      },
    ),
  ]);
  const tCards = Date.now();
  console.log(
    "[weekly-cards][timing] getWeeklyGrowth",
    `crew=${tCrew - t0}ms`,
    `currentWeek=${tCurrentWeek - tCrew}ms`,
    `summary+cards=${tCards - tCurrentWeek}ms`,
    `total=${tCards - t0}ms`,
  );

  const { cards: weeklyCards, flippedToFail } = weeklyResult;

  // 요약 일관성: computeGrowthSummary 는 DB status 만 집계하므로, 필수 슬롯 verdict 로
  // success→fail 전환된 주차 수만큼 approved↓ / failed↑ 보정한다 (availableWeeks 불변).
  if (flippedToFail > 0) {
    growthSummary.approvedWeeks = Math.max(
      0,
      growthSummary.approvedWeeks - flippedToFail,
    );
    growthSummary.failedWeeks += flippedToFail;
  }

  const seasonGrowthRates = computeSeasonGrowthRates(weeklyCards);

  return { currentWeekInfo, growthSummary, weeklyCards, seasonGrowthRates };
}

// ─────────────────────────────────────────────────────────────────────
// User-facing: auth.users.id → profile.user_id 해소 후
// 어드민과 동일한 getWeeklyGrowth() 경로를 호출하여 1:1 일치 보장.
// ─────────────────────────────────────────────────────────────────────
export async function getWeeklyGrowthByUserId(
  authUserId: string,
  authEmail?: string | null,
): Promise<WeeklyGrowthDto | null> {
  const TAG = "[getWeeklyGrowthByUserId]";

  const resolvedUserId = await resolveProfileUserId(authUserId, authEmail);
  if (!resolvedUserId) {
    console.warn(TAG, "no profile for auth.id =", authUserId, "| email =", authEmail);
    return null;
  }

  if (resolvedUserId !== authUserId) {
    console.log(TAG, "ID resolved: auth.id =", authUserId, "→ profile.user_id =", resolvedUserId);
  }

  return getWeeklyGrowth(resolvedUserId);
}

// ─────────────────────────────────────────────────────────────────────
// 실무 경험 필수 슬롯(도출/분석/평가) 성장 실패 → user_week_statuses.status SYNC
//
// SoT = user_week_statuses.status. weekly-cards 의 read-time override 는 sync 전 갭 보정용으로
// 유지하되, 최종 상태는 이 sync 가 DB 에 영속화한다 (단방향: success → fail 만).
//
// 불변식 (코드 + 쿼리 이중 방어):
//   - 변경 후보는 status='success' 인 주차뿐 (.eq("status","success") 가드).
//     → personal_rest / official_rest / 기존 fail 은 물리적으로 매칭되지 않아 절대 변경 불가.
//   - verdict.status === "fail" 이고 현재주(running)가 아닐 때만 fail 로 갱신.
//   - pending / pass / not_applicable / running 은 DB 에 쓰지 않는다.
//   - 멱등: 한 번 fail 로 바뀐 행은 다음 실행에서 success 필터에 안 걸려 no-op.
// weekly-cards GET 경로에서는 절대 호출하지 않는다 (조회는 side-effect 없음).
// ─────────────────────────────────────────────────────────────────────

export type ExperienceGrowthSyncResult = {
  userId: string;
  scannedSuccessWeeks: number; // status='success' 후보 주차 수
  flippedToFail: number; // dryRun=false: 실제 success→fail 갱신 수 / dryRun=true: 변경 예정 수
  flippedWeekKeys: string[]; // "year-week_number"
  dryRun: boolean; // true 면 DB write 없이 변경 예정만 계산
};

// display_name 에 t/T 포함 → 테스트 사용자 (DB 의 ILIKE '%T%' 와 동일 의미).
// 개발자 모드에서 실사용자 보호 판단에 쓰는 단일 기준 (fetchTestUserIds 와 의미 일치).
export function isTestDisplayName(name: string | null | undefined): boolean {
  return !!name && /t/i.test(name);
}

export async function syncExperienceGrowthWeekStatuses(
  userId: string,
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncResult> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const empty: ExperienceGrowthSyncResult = {
    userId,
    scannedSuccessWeeks: 0,
    flippedToFail: 0,
    flippedWeekKeys: [],
    dryRun,
  };

  // 1. 변경 후보 = status='success' 주차만 (rest/fail 은 애초에 제외 → 물리적 방어).
  const { data: successData, error: successErr } = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number,week_start_date")
    .eq("user_id", userId)
    .eq("status", "success");

  if (successErr || !successData || successData.length === 0) return empty;
  type SuccRow = {
    year: number;
    week_number: number;
    week_start_date: string;
  };
  const successRows = successData as SuccRow[];

  // 2. week_start_date → weeks.id
  const startDates = [...new Set(successRows.map((r) => r.week_start_date))];
  const { data: weeksData } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date")
    .in("start_date", startDates);
  const weekIdByStart = new Map<string, string>();
  for (const w of (weeksData ?? []) as {
    id: string;
    start_date: string | null;
  }[]) {
    if (w.start_date) weekIdByStart.set(w.start_date, w.id);
  }
  const weekCardIds = [...new Set([...weekIdByStart.values()])];
  if (weekCardIds.length === 0) {
    return { ...empty, scannedSuccessWeeks: successRows.length };
  }

  // 3. 필수 슬롯 verdict (weekly-cards 와 동일 함수·기준 → 화면=DB 일치 보장).
  const verdictMap = await fetchExperienceRequiredSlotStatusByWeek(
    userId,
    weekCardIds,
    now,
  );

  // 4. 현재 주차 (running = DB 미반영 상태 → sync 대상에서 제외).
  const todayIso = new Date(now).toISOString().slice(0, 10);
  const currentSeason = getSeasonForDate(todayIso);
  const currentWeek = currentSeason
    ? getWeekInSeason(currentSeason, todayIso)
    : null;
  const currentYear = new Date(now).getUTCFullYear();
  const updatedAtIso = new Date(now).toISOString();

  // 5. fail 대상만 success→fail 갱신. .eq("status","success") 가 rest/fail 방어 + 멱등 보장.
  const flippedWeekKeys: string[] = [];
  for (const r of successRows) {
    const weekId = weekIdByStart.get(r.week_start_date);
    if (!weekId) continue;
    const verdict = verdictMap.get(weekId);
    const isCurrent = Boolean(
      currentWeek &&
        r.year === currentYear &&
        r.week_start_date === currentWeek.weekStart,
    );
    // 후보는 모두 status='success' 이므로 currentStatus='success' 고정. verdict fail + 비현재주만 통과.
    if (!shouldSyncWeekStatusToFail("success", verdict?.status ?? "pass", isCurrent)) {
      continue; // pass/pending/not_applicable/현재주 → no-op
    }

    // dry-run: 변경 예정만 집계하고 DB 는 건드리지 않는다.
    if (dryRun) {
      flippedWeekKeys.push(`${r.year}-${r.week_number}`);
      continue;
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("user_week_statuses")
      .update({ status: "fail", updated_at: updatedAtIso })
      .eq("user_id", userId)
      .eq("year", r.year)
      .eq("week_number", r.week_number)
      .eq("status", "success") // ⬅ 핵심 가드: success 행만 — rest/fail 물리적 보호 + 멱등
      .select("year,week_number");

    if (!updErr && updated && updated.length > 0) {
      flippedWeekKeys.push(`${r.year}-${r.week_number}`);
    }
  }

  return {
    userId,
    scannedSuccessWeeks: successRows.length,
    flippedToFail: flippedWeekKeys.length,
    flippedWeekKeys,
    dryRun,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 개인(크루 단위) sync 정책 — 개발자 모드 기준.
//   - 테스트 사용자(display_name ILIKE '%T%')       → 항상 write 허용.
//   - 실사용자 + devMode=true                        → dry-run 만 (DB 미반영, 실사용자 보호).
//   - 실사용자 + devMode=false + confirm=true        → write 허용 (운영 반영).
//   - 실사용자 + devMode=false + confirm=false       → dry-run 만.
// fail 판정 정책 자체는 테스트/실사용자 동일 — 여기서는 "DB 반영 여부"만 모드로 가른다.
// ─────────────────────────────────────────────────────────────────────
export type PersonalSyncDecision = {
  userId: string;
  displayName: string | null;
  isTestUser: boolean;
  mode: "write" | "dry_run"; // dry_run = DB 미반영(차단)
  reason: string;
  result: ExperienceGrowthSyncResult;
};

export async function syncExperienceGrowthForCrew(
  legacyUserId: string,
  opts: { devMode: boolean; confirm: boolean; now?: number },
): Promise<PersonalSyncDecision | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew || !crew.userId) return null;

  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", crew.userId)
    .maybeSingle();
  const displayName =
    (prof as { display_name: string | null } | null)?.display_name ?? null;
  const isTestUser = isTestDisplayName(displayName);

  let mode: "write" | "dry_run";
  let reason: string;
  if (isTestUser) {
    mode = "write";
    reason = "테스트 사용자(%T%) — 항상 반영 허용";
  } else if (opts.devMode) {
    mode = "dry_run";
    reason = "개발자 모드: 실사용자는 dry-run 만 (DB 미반영)";
  } else if (opts.confirm) {
    mode = "write";
    reason = "운영 모드 + confirm=true — 실사용자 반영 허용";
  } else {
    mode = "dry_run";
    reason = "운영 모드 + confirm 없음 — dry-run 만";
  }

  const result = await syncExperienceGrowthWeekStatuses(crew.userId, {
    now: opts.now,
    dryRun: mode !== "write",
  });

  return { userId: crew.userId, displayName, isTestUser, mode, reason, result };
}

export type ExperienceGrowthSyncAllResult = {
  scope: "all" | "test"; // 운영 전체 vs 테스트 사용자(display_name ILIKE '%T%')만
  dryRun: boolean; // true 면 DB write 없이 변경 예정만 계산
  usersScanned: number; // 이 scope 에서 success 보유 대상 사용자 수
  usersFlipped: number; // 1건 이상 fail 전환(예정)된 사용자 수
  totalFlippedToFail: number; // 전체 success→fail 전환(예정) 주차 수
  results: ExperienceGrowthSyncResult[]; // 변경(예정) 발생한 사용자만
};

// status='success' 보유 사용자 distinct.
async function fetchUsersWithSuccessWeeks(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("status", "success");
  if (error || !data) return [];
  return [...new Set((data as { user_id: string }[]).map((r) => r.user_id))];
}

// 테스트 사용자 user_id 집합 (display_name 에 'T' 포함, 대소문자 무시).
async function fetchTestUserIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .ilike("display_name", "%T%");
  if (error || !data) return new Set();
  return new Set((data as { user_id: string }[]).map((r) => r.user_id));
}

async function syncExperienceGrowthForUserIds(
  scope: "all" | "test",
  userIds: string[],
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncAllResult> {
  const dryRun = opts.dryRun ?? false;
  const results: ExperienceGrowthSyncResult[] = [];
  let totalFlippedToFail = 0;
  for (const uid of userIds) {
    const r = await syncExperienceGrowthWeekStatuses(uid, { now: opts.now, dryRun });
    if (r.flippedToFail > 0) {
      results.push(r);
      totalFlippedToFail += r.flippedToFail;
    }
  }
  return {
    scope,
    dryRun,
    usersScanned: userIds.length,
    usersFlipped: results.length,
    totalFlippedToFail,
    results,
  };
}

// 운영용: 전체 사용자(실사용자 포함) 대상. dryRun=false(실반영)는 confirm 흐름을 거친 뒤에만 호출.
export async function syncAllExperienceGrowthWeekStatuses(
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncAllResult> {
  const userIds = await fetchUsersWithSuccessWeeks();
  return syncExperienceGrowthForUserIds("all", userIds, opts);
}

// 테스트용: display_name 에 'T' 포함된 테스트 사용자만 대상 (실사용자 오적용 방지).
export async function syncTestExperienceGrowthWeekStatuses(
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncAllResult> {
  const [successIds, testIds] = await Promise.all([
    fetchUsersWithSuccessWeeks(),
    fetchTestUserIds(),
  ]);
  const userIds = successIds.filter((id) => testIds.has(id));
  return syncExperienceGrowthForUserIds("test", userIds, opts);
}
