import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  isTestUser as isMarkedTestUser,
  fetchTestUserMarkerIds,
} from "@/lib/testUsers";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  getSeasonForDate,
  getSeasonCalendar,
  getCalendarWeekStatus,
  isTransitionWeekStart,
  seasonDbKey,
  seasonTypeToCode,
  type Season,
} from "@/lib/seasonCalendar";
import { getGraduationThreshold } from "@/lib/pointLabels";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
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
  type SeasonSummary,
  type SeasonStatus,
  type SeasonPointSummary,
  type SeasonActivityStatus,
  type RestReason,
  type EndStatus,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  EXPERIENCE_ALWAYS_OPEN_SLOT_ORDERS,
  EXPERIENCE_MANAGEMENT_SLOT_ORDER,
  fetchLegacyUnifiedExperienceByWeek,
  fetchManagementSlotOpen,
  fetchWeeklyCardLineAggregates,
  fetchExperienceRequiredSlotStatusByWeek,
  fetchWeeksWithOpenLinesByPart,
  shouldSyncWeekStatusToFail,
  buildWeekAvailability,
  roundGrowthRate,
  type ExperienceGrowthVerdict,
  type LegacyUnifiedWeekState,
} from "@/lib/lineAvailability";
import { EXPERIENCE_RATING_FAIL_THRESHOLD } from "@/lib/cluster4Enhancement";
import { foldGrowthMetrics, deriveEndStatus } from "@/lib/growthCore";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { loadGrowthInput } from "@/lib/growthLoader";
import { buildResolvedWeeks } from "@/lib/growthResolve";

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
async function computeGrowthSummary(
  userId: string,
  cards: WeeklyCardDto[],
): Promise<GrowthSummary> {
  // Growth Core 공통 입력 번들(Layer 0)로 조회 일원화. profile/week/season 은
  // start/end 표시·시즌 휴식 수·종료 상태 산정에 사용한다.
  let input;
  try {
    input = await loadGrowthInput(userId);
  } catch {
    return emptyGrowthSummary();
  }

  const weeks = input.weekStatuses;
  if (weeks.length === 0) return emptyGrowthSummary();

  const restSeasonCount = input.seasonStatuses.filter(
    (s) => s.status === "rest",
  ).length;

  // 성장 지표 카운트 — ResolvedWeek(카드) 기반 클린 파이프라인.
  //   raw uws 가 아니라 resolveWeekResultStatus 결과(카드 resultStatus)를 fold 한다.
  //   → 미공표 success 는 tallying 으로 빠지고, verdict fail 전환이 자동 반영된다.
  const { approvedWeeks, failedWeeks, restWeeks, availableWeeks } =
    foldGrowthMetrics({
      weeks: cards.map((c) => ({
        status: c.resultStatus,
        isTransition: c.isTransition,
      })),
      restSeasonCount,
    });

  const first = weeks[0];
  const startWeekDisplay = formatSeasonRelativeWeekDisplay(first, "");

  const profileData = input.profile;

  // 종료 상태 — Growth Core 순수 함수로 추출(동작 불변). endWeekDisplay 포맷은 유지.
  const endStatus: EndStatus = deriveEndStatus(
    profileData?.growth_status ?? null,
  );
  let endWeekDisplay = "~ing (성장 진행 중)";

  if (endStatus === "completed") {
    const last = weeks[weeks.length - 1];
    endWeekDisplay = formatSeasonRelativeWeekDisplay(last, "(성장 완료)");
  } else if (endStatus === "stopped") {
    const last = weeks[weeks.length - 1];
    endWeekDisplay = formatSeasonRelativeWeekDisplay(last, "(성장 중단)");
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

// 성장 시작/종료 주차 표기 — "현재 클럽 상태 문구"(currentWeekInfo)와 **동일 기준**으로
// 시즌상대주차를 산정한다: getSeasonForDate(week_start_date) → getWeekInSeason(season, …).
//   - 화면 표기: "{시즌 연도}년, {시즌명} 시즌, {시즌상대주차}주차{suffix}"
//   - user_week_statuses.week_number(ISO 원본)는 내부 보존되며, 화면 display 만 시즌상대주차로 내려간다.
//   - week_start_date 없음 또는 달력 갭(시즌 판별 불가) → 기존 ISO 표기로 안전 폴백.
function formatSeasonRelativeWeekDisplay(
  row: {
    year: number;
    week_number: number;
    week_start_date: string | null;
    season_key: string | null;
  },
  suffix: string,
): string {
  const startIso = row.week_start_date;
  const season = startIso ? getSeasonForDate(startIso) : null;
  if (season && startIso) {
    // currentWeekInfo.weekNumber 와 동일 산정식(시즌 시작일 기준 7일 블록).
    const { weekNumber } = getWeekInSeason(season, startIso);
    return `${season.year}년, ${season.type} 시즌, ${weekNumber}주차${suffix}`;
  }
  // 폴백: season_key 라벨 + ISO 주차(시즌 판별 불가 시에만).
  const label = row.season_key ? formatSeasonKeyToLabel(row.season_key) : "";
  return label
    ? `${row.year}년, ${label}, ${row.week_number}주차${suffix}`
    : `${row.year}년, ${row.week_number}주차${suffix}`;
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
): Promise<{ cards: WeeklyCardDto[] }> {
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
    return { cards: [] };
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
  // 상한 = max(현재 주차, 마지막 uws 주차). 시즌 전체가 시드된 사용자(테스터)는 미래 주차
  // uws 가 존재하므로 latestUwsStart 까지 weeks 를 조회해야 한다. 종전엔 삼항 양쪽이 모두
  // currentWeekStart 인 no-op 이라 미래 주차 weeks row 가 조회 범위 밖 → 해당 uws 가 고아로
  // 오인돼 합성주차(week_number=null)가 되고 displayWeekNum 이 ISO 주차(24/25)로 폴백,
  // "봄 시즌 24주차" 같은 시즌 초과 주차 제목이 만들어지는 버그가 있었다 (2026-06-05 수정).
  const upperBound = currentWeekStart
    ? currentWeekStart > latestUwsStart
      ? currentWeekStart
      : latestUwsStart
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

  // 6. 주차별 강화율 분자 B = part별 (배정 target 중 마감 지난) success 수.
  // 4개 part 모두 동일 기준: target + submission_closes_at 마감, 제출 무관 (강화상태 success 와 동일).
  // (info/experience/competency 의 분모 A 는 본인 배정 수가 아니라 openedByPart 의 "개설 라인 수"를 쓴다.)
  let infoSuccessMap = new Map<string, number>();
  let abilitySuccessMap = new Map<string, number>();
  let experienceSuccessMap = new Map<string, number>();
  let careerSuccessMap = new Map<string, number>();
  // career 분모 A = 사용자 배정 career 라인 수 (미선발=not_applicable → 개설 수 미사용).
  let careerLineMap = new Map<string, number>();
  // 실무 경험 필수 슬롯(도출/분석/평가) verdict: weekId → verdict. (강화율/평점/5슬롯 로직과 독립)
  let experienceVerdictMap = new Map<string, ExperienceGrowthVerdict>();
  // 강화율 분모 A(info/experience/competency) = 그 주차 "개설된 distinct 라인 수".
  //   본인 배정 ⊆ 개설 → "개설됐는데 본인 미배정"이 synthetic fail (A 포함, B 미포함).
  //   미개설(0) → not_applicable(분모 제외). career 는 제외(미선발=not_applicable → careerLineMap 사용).
  // 안전 바닥값: 개설 수와 "본인 배정 수"(aggregates)의 max 를 쓴다 — 만일 전-유저 타깃 조회가
  //   행 상한에 걸려 개설 수를 과소집계해도 본인 배정 수 미만으로 떨어지지 않아 rate>100% 를 방지한다.
  let infoAvailMap = new Map<string, number>();
  let experienceAvailMap = new Map<string, number>();
  let competencyAvailMap = new Map<string, number>();

  // 레거시(허브 도입 전) 주차 집합 — weekId 기준 (id 있는 카드 주차만).
  const legacyWeekIdSet = new Set<string>();
  for (const w of cardWeeksDesc) {
    if (w.id && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) {
      legacyWeekIdSet.add(w.id);
    }
  }
  // 레거시 주차의 통합 라인 상태 (집계 override + verdict 공용).
  let legacyUnifiedStates = new Map<string, LegacyUnifiedWeekState>();

  if (weekCardIds.length > 0) {
    // 허브/라인 체계 적용 주차(2026-06-05 개정): "필수 슬롯 항상-개설(라인 행 없어도 fail)"
    // 신정책 적용 집합. 조건 = 공표 완료(판정 완료) && 비현재주 && 비전환주 &&
    // start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM (사용자 유형 무관 — 테스터 예외 폐기).
    // running/tallying(판정 전)은 fail 선반영 금지. 레거시 주차는 통합 라인 정책으로 별도 처리.
    // 관리(5) 슬롯 게이트 — weekly-cards 라인 빌더와 동일 기준(membership_level 심화/운영진만 개방).
    const managementSlotOpen = await fetchManagementSlotOpen(userId);
    const slotPolicyWeekIds = new Set<string>();
    for (const w of cardWeeksDesc) {
      if (!w.id) continue;
      if (!isWeekPublished(w) || isCurrentWeekStart(w.start_date)) continue;
      if (isTransitionWeekStart(w.start_date)) continue;
      if (w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) continue;
      slotPolicyWeekIds.add(w.id);
    }

    // 기존 9개 fetch* (cluster4_lines 9회 + cluster4_line_targets 8회 ≈ 17~20 쿼리) 를
    // bulk aggregate(최대 3쿼리) + verdict(최대 3쿼리) + opened(2쿼리) = 최대 8쿼리로 축소.
    const tLines = Date.now();
    legacyUnifiedStates = await fetchLegacyUnifiedExperienceByWeek(
      userId,
      [...legacyWeekIdSet],
      Date.now(),
      // 조직별 check 기준값(org_week_thresholds) 해석 — 파이프라인 보유 org 전달(재조회 0).
      { organizationSlug: organization },
    );
    const [aggregates, experienceVerdict, opened] = await Promise.all([
      fetchWeeklyCardLineAggregates(userId, weekCardIds),
      // 필수 슬롯 verdict (성장 실패 판정 SoT). 신정책 주차(slotPolicyWeekIds)만
      // "항상-개설" 기준으로 산정 — 레거시 주차는 통합 라인 단일 verdict(상태 재사용).
      fetchExperienceRequiredSlotStatusByWeek(userId, weekCardIds, Date.now(), {
        alwaysOpenWeekIds: slotPolicyWeekIds,
        legacyUnifiedStates,
        organizationSlug: organization,
      }),
      // 라인 개설 여부(part별) — synthetic fail 분모 A 가산용.
      fetchWeeksWithOpenLinesByPart(weekCardIds),
    ]);
    console.log(
      "[weekly-cards][timing] line aggregates+verdict",
      `${Date.now() - tLines}ms`,
      `| weeks=${weekCardIds.length}`,
    );

    infoSuccessMap = aggregates.infoSuccessMap;
    abilitySuccessMap = aggregates.abilitySuccessMap;
    experienceSuccessMap = aggregates.experienceSuccessMap;
    careerSuccessMap = aggregates.careerSuccessMap;
    careerLineMap = aggregates.careerLineMap;
    experienceVerdictMap = experienceVerdict;
    // A = max(개설 distinct 라인 수, 본인 배정 수). 보통 개설 수가 더 크다(synthetic fail 포함).
    const maxMerge = (
      openedMap: Map<string, number>,
      userMap: Map<string, number>,
    ): Map<string, number> => {
      const out = new Map(openedMap);
      for (const [k, v] of userMap) out.set(k, Math.max(out.get(k) ?? 0, v));
      return out;
    };
    infoAvailMap = maxMerge(opened.info, aggregates.infoLineMap);
    // 관리(5) 슬롯 잠금 사용자: 개설 distinct 라인 수에서 관리 슬롯 라인을 차감한다 —
    // 고객앱이 관리 슬롯 카드를 잠가(미노출) 분모에 들어가면 "총 N개 > 표시 칸" 불일치
    // (weekly-cards 라인 빌더의 synthetic fail 생략과 동일 게이트).
    const openedExperienceForUser = new Map(opened.experience);
    if (!managementSlotOpen) {
      for (const [w, mgmtCount] of opened.experienceManagementLineCount) {
        const cur = openedExperienceForUser.get(w);
        if (cur != null && mgmtCount > 0) {
          openedExperienceForUser.set(w, Math.max(0, cur - mgmtCount));
        }
      }
    }
    experienceAvailMap = maxMerge(openedExperienceForUser, aggregates.experienceLineMap);
    competencyAvailMap = maxMerge(opened.competency, aggregates.competencyLineMap);

    // 실무 경험 분모 A 슬롯 보정 (2026-06-04): 신정책 주차(slotPolicyWeekIds — 판정 완료 +
    // 테스트 전 주차/실사용자 EFFECTIVE_FROM 이후)에 한해, 필수 슬롯(1·2·3·5)을 라인 행이
    // 없어도 "오픈/마감된 칸"으로 본다 → A = max(개설 distinct, 본인 배정) + 미개설 필수 슬롯 수.
    // 개설 0 주차도 A=4 (필수 슬롯 4칸 전부 fail). 확장 슬롯(4)은 개설 주차에만 분모 포함(기존).
    // 신정책 미적용 주차(진행/집계 중·실사용자 과거·휴식·전환)는 기존 분모 유지 — 라인 칸
    // placeholder(해당 없음, 분모 제외)와 정합.
    // 관리(5) 슬롯은 잠금 사용자에게 "항상-개설" 미적용(차감과 동일 게이트) — A=3 (1·2·3만).
    for (const w of weekCardIds) {
      if (!slotPolicyWeekIds.has(w)) continue;
      const openSlots = opened.experienceOpenSlots.get(w);
      let missing = 0;
      for (const s of EXPERIENCE_ALWAYS_OPEN_SLOT_ORDERS) {
        if (s === EXPERIENCE_MANAGEMENT_SLOT_ORDER && !managementSlotOpen) continue;
        if (!openSlots?.has(s)) missing += 1;
      }
      if (missing > 0) {
        experienceAvailMap.set(w, (experienceAvailMap.get(w) ?? 0) + missing);
      }
    }

    // 레거시(허브 도입 전) 주차 집계 override (2026-06-05 통합 라인 정책):
    //   실무 정보/역량/경력 = 라인 없음 → A·B 전부 0 (not_applicable, 분모 제외).
    //   실무 경험 = 통합 라인 1개 기준 — 개설 시 A=1, B=강화 성공(타깃+마감+평점 4 이상/미평가) 1.
    //   미개설 주차 A=0. 카드 경로(fetchLineDetailsByWeek 레거시 게이트 + breakdownFromLines)와
    //   동일 칸 집합을 SQL 집계 경로에도 강제해 weekly-growth 단독 소비 화면과의 divergence 를 막는다.
    for (const w of legacyWeekIdSet) {
      infoAvailMap.delete(w);
      infoSuccessMap.delete(w);
      competencyAvailMap.delete(w);
      abilitySuccessMap.delete(w);
      careerLineMap.delete(w);
      careerSuccessMap.delete(w);
      const u = legacyUnifiedStates.get(w);
      if (u?.opened) {
        experienceAvailMap.set(w, 1);
        const success =
          u.hasTarget &&
          u.deadlinePassed &&
          !(u.rating != null && u.rating <= EXPERIENCE_RATING_FAIL_THRESHOLD);
        experienceSuccessMap.set(w, success ? 1 : 0);
      } else {
        experienceAvailMap.delete(w);
        experienceSuccessMap.delete(w);
      }
    }
  }

  // 9. 누적 계산 (오름차순) — 카드 주차 기준, start_date 키.
  //    확정 누적 = "공표 완료된 DB success" 만 센다. 현재주(진행 중)·미공표 주차(집계 중)·
  //    uws 없는 주차는 확정 전/대상 아님이므로 제외 → 카드의 +1 프리뷰가 더할 base (정책 5).
  //    필수 슬롯 verdict=fail 이면 success 에서 제외 → 배지·누적·요약 일관성 유지.
  //    전환 주차는 제외(2026-06-04 누적 주차 SoT 통일) — 이력서 카드(computeSeasonRecords)·
  //    cluster3(foldGrowthMetrics)와 동일 규칙. 종전에는 전환 주차 success 가 +1 되어
  //    cluster4 누적(8)이 이력서/cluster3(7)와 갈라지는 결함이 있었다.
  let cumulativeSuccess = 0;
  const accByStart = new Map<string, number>();
  for (const w of cardWeeksAsc) {
    const uws = uwsByStart.get(w.start_date);
    const verdict = w.id ? experienceVerdictMap.get(w.id) : undefined;
    const isCurrent = isCurrentWeekStart(w.start_date);
    const published = isWeekPublished(w);
    let countsAsSuccess =
      uws?.status === "success" &&
      published &&
      !isCurrent &&
      !isTransitionWeekStart(w.start_date);
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
  // 주차별 resolved status 목록(공유 resolver). 카드 조립은 이 결과를 소비한다.
  //   (buildResolvedWeeks 는 flippedToFail 도 반환하지만 요약은 카드 fold 로 산출하므로 미사용.)
  const { byStart: resolvedByStart } = buildResolvedWeeks(
    cardWeeksDesc,
    {
      getUwsStatus: (s) => uwsByStart.get(s)?.status ?? null,
      getVerdictStatus: (id) =>
        id ? (experienceVerdictMap.get(id)?.status ?? null) : null,
      activeRestPeriods,
      isCurrentWeekStart,
      isWeekPublished,
    },
  );

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

    // ── 주차 결과 6종 — 공유 resolver(buildResolvedWeeks) 결과 소비 ──
    //   no_data 주차는 맵에 없음 → 카드 미생성(기존 `continue` 동일).
    //   experienceVerdict 는 아래 experienceGrowth DTO 표시에만 사용(판정은 이미 resolver 내부).
    const rw = resolvedByStart.get(startDate);
    if (!rw) continue;
    const resultStatus: WeekResultStatus = rw.resultStatus;
    const experienceVerdict = weekCardId
      ? experienceVerdictMap.get(weekCardId)
      : undefined;
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
          // 주차 인정 check 게이트 (레거시 통합 라인 주차에서만 채워짐).
          checkGate: experienceVerdict.checkGate ?? null,
        }
      : {
          status: "not_applicable",
          requiredSlots: [],
          failedSlotOrders: [],
          appliedToWeekStatus: false,
          checkGate: null,
        };

    const isRest =
      resultStatus === "personal_rest" ||
      resultStatus === "official_rest";

    // 라인 가용 수(A): info/experience/competency 는 "개설 라인 수"(개설+본인미배정 synthetic fail 포함),
    // career 는 본인 배정 수(careerLineMap, 미선발=not_applicable). 이행 수(B): info/ability/experience 는
    // target+마감 기준, career(P1)는 target+마감+grade C이상 기준(평점 반영 — per-line 과 일치).
    // 본인 배정 ⊆ 개설 라인 이므로 항상 B ≤ A. 미개설(0)·휴식(isRest)이면 A=0(not_applicable·분모 제외).
    const avail = isRest
      ? { info: 0, ability: 0, experience: 0, career: 0 }
      : buildWeekAvailability(
          weekCardId,
          infoAvailMap,
          // careerMap(레거시 project 기반)은 미사용. career A 는 careerUserMap(per-user)로 전달.
          new Map<string, number>(),
          organization,
          experienceAvailMap,
          competencyAvailMap,
          careerLineMap,
        );

    // 실무 역량 단일 정규화 (2026-06-04 v14): 역량은 1인·1주차 항상 1칸 — 라인 수 무관 A=1,
    // B=성공 1건 이상이면 1 (cap). 휴식/전환 주차만 0 (분모 제외). 카드 경로(2.7 fold)와 동일 산식.
    // 레거시(허브 도입 전) 주차는 역량 허브 자체가 없으므로 A=0 (통합 라인 정책 — 카드 경로 동일).
    const abilityNormalized =
      isRest ||
      isTransitionWeekStart(startDate) ||
      !weekCardId ||
      legacyWeekIdSet.has(weekCardId)
        ? { completed: 0, available: 0 } // 휴식/전환/weekId 미상/레거시 — 분모 제외(카드 경로 동일)
        : {
            completed: (abilitySuccessMap.get(weekCardId) ?? 0) > 0 ? 1 : 0,
            available: 1,
          };
    const lineBreakdown: WeeklyCardLineBreakdown = {
      // info/experience B = target+마감 success(제출 무관). career B = target+마감+grade C이상(P1).
      info: { completed: isRest ? 0 : (weekCardId ? (infoSuccessMap.get(weekCardId) ?? 0) : 0), available: avail.info },
      ability: abilityNormalized,
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

  return { cards };
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
// cluster-4-1 진입 화면 시즌 요약 (area-1-title / area-4-stats).
//   seasonSummary  — 현재 시즌(seasonCalendar) 단일 정보. 사용자 무관(달력만).
//   seasonPointSummary — 그 시즌의 비전환 주차 user_weekly_points 누적(별/방패/번개).
//     이미 조립된 weeklyCards 에서 집계하므로 추가 쿼리 0 + 화면 카드와 값 일치 보장.
//
// 시즌 범위는 "정규 주수"(봄/가을 16, 여름/겨울 8)만 — 전환 주차(seasonWeeks+1)는 제외한다.
//   seasonCalendar 의 season.endDate 는 전환 주차를 포함한 집계 끝이므로, 여기서는
//   start + seasonWeeks*7 - 1 로 정규 시즌의 마지막 일요일을 따로 계산한다.
// ─────────────────────────────────────────────────────────────────────
function fmtDotDate(iso: string): string {
  return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

const SEASON_STATUS_LABEL: Record<SeasonStatus, string> = {
  active: "진행중",
  ended: "종료",
  upcoming: "예정",
};

function buildSeasonSummary(season: Season, todayIso: string): SeasonSummary {
  // 정규 시즌 마지막 일요일 (전환 주차 제외) = start + seasonWeeks 주 - 1일.
  const seasonProperEndMs =
    toMs(season.startDate) + season.seasonWeeks * 7 * DAY_MS - DAY_MS;
  const startDate = season.startDate;
  const endDate = fmtDate(seasonProperEndMs);

  const todayMs = toMs(todayIso);
  let status: SeasonStatus;
  if (todayMs < toMs(startDate)) status = "upcoming";
  else if (todayMs > seasonProperEndMs) status = "ended";
  else status = "active";

  const yy = String(season.year).slice(2);
  return {
    year: season.year,
    seasonName: season.type,
    seasonCode: seasonTypeToCode(season.type),
    displayTitle: `${yy}년도 ${season.type} 시즌`,
    dateRangeLabel: `${fmtDotDate(startDate)} - ${fmtDotDate(endDate)}`,
    status,
    statusLabel: SEASON_STATUS_LABEL[status],
    startDate,
    endDate,
  };
}

// 현재 시즌 누적 포인트 — weeklyCards 중 (seasonKey == 현재 시즌) && (전환 주차 아님)
//   카드 범위는 [최초 활동 주차, 현재 주차]이므로 "현재 시즌 현재까지 누적"과 일치.
//   포인트 row 없는 주차(pointsRaw=null)는 0 으로 취급(미데이터=0 누적).
// 포인트 표시 정책(2026-06-04 통일): 고객 노출 값은 표시 최종값.
//   별 = Σpoints · 방패 = net(Σadvantages−Σpenalty) · 번개 = −Σpenalty (음수 표기).
//   raw advantage 는 내부 집계 전용 — 고객 DTO 로 내보내지 않는다.
function computeSeasonPointSummary(
  cards: WeeklyCardDto[],
  currentSeasonKey: string | null,
): SeasonPointSummary {
  let star = 0;
  let advRaw = 0;
  let pen = 0;
  if (currentSeasonKey) {
    for (const c of cards) {
      if (c.seasonKey !== currentSeasonKey) continue;
      if (c.isTransition) continue; // 전환 주차 제외
      star += c.pointsRaw ?? 0;
      advRaw += c.advantagesRaw ?? 0;
      pen += c.penaltyRaw ?? 0;
    }
  }
  return { star, shield: advRaw - pen, lightning: -pen };
}

// ─────────────────────────────────────────────────────────────────────
// area-8-season-status: 현재 시즌 팀/파트/상태 활동 이력 (최대 6개, 발생순).
//
// source(이력):  user_team_parts (team_id/part_id/joined_at/left_at/managed_team_id) — 팀/파트 시간축.
//                user_role_history (role/started_at/ended_at) — 역할(상태) 시간축.
// 라벨:          teams.name / parts.name.
// 상태 결정:     role(이력 우선) + user_memberships.membership_level(현재 등급) + user_profiles.role(fallback).
// 시즌 범위:     [season.startDate, season.endDate] (전환주차 포함)와 겹치는 user_team_parts row 만.
// 정렬:          startedAt(=joined_at) ASC, 없으면 마지막. 연속 동일(team/part/status) 병합 후 최대 6개.
// fallback:      시즌과 겹치는 user_team_parts row 가 없으면 현재 membership/profile 로 단일 항목
//                (startedAt/endedAt=null) — 대부분의 실사용자(이력 테이블 미사용)가 이 경로.
// 실패 안전:     어떤 쿼리가 실패해도 throw 하지 않고 [] 로 폴백 — DTO 전체를 보호한다.
// ─────────────────────────────────────────────────────────────────────

const OPERATIONS_TEAM_LABEL = "운영진(n기)";
const OPERATIONS_PART_LABEL = "클럽 단위";
const MAX_SEASON_ACTIVITY_STATUSES = 6;

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function normalizeRoleToken(role: string | null): string {
  return (role ?? "").trim().toLowerCase();
}

function isTeamLeaderRole(role: string | null): boolean {
  const r = normalizeRoleToken(role);
  const raw = (role ?? "").trim();
  return (
    r === "team_leader" ||
    r === "operations_team_leader" ||
    r === "operations_teamleader" ||
    raw === "운영진(팀장)" ||
    raw === "팀장"
  );
}

function isAmbassadorRole(role: string | null): boolean {
  const r = normalizeRoleToken(role);
  const raw = (role ?? "").trim();
  return (
    r === "ambassador" ||
    r === "operations_ambassador" ||
    raw === "운영진(앰배서더)" ||
    raw === "앰배서더"
  );
}

// 등급 SoT = user_memberships.membership_level (2026-06-04 통일 — /admin/members
// memberStatusLabel 과 동일 정책). role 은 "심화" 등급 내 직책(파트장/에이전트) 구분
// 보조로만 쓴다 — role=part_leader 여도 level=일반이면 "일반"(role 단독으로
// 심화(파트장)을 만들지 않는다). 운영진(팀장/앰배서더)은 등급 체계 밖이라 기존
// role 판정 유지(isTeamLeaderRole/isAmbassadorRole — buildActivityLabels 선행 분기).
function isAdvancedLevel(level: string | null): boolean {
  return (level ?? "").trim().startsWith("심화");
}

function isPartLeaderRole(role: string | null, level: string | null): boolean {
  if (!isAdvancedLevel(level)) return false; // 등급 게이트: 심화가 아니면 파트장 표기 금지
  const r = normalizeRoleToken(role);
  const raw = (role ?? "").trim();
  return r === "part_leader" || raw === "파트장" || (level ?? "").trim() === "심화(파트장)";
}

function isAgentRole(role: string | null, level: string | null): boolean {
  // 심화 등급에서 파트장이 아니면 전부 에이전트 표기 (role=agent/crew/기타 무관 —
  // 기존에도 lv==="심화" 단독으로 에이전트 처리했던 동작을 보존).
  return isAdvancedLevel(level) && !isPartLeaderRole(role, level);
}

// "팀장(00 팀)" 라벨. 이름이 이미 "팀"으로 끝나면 중복하지 않는다.
function formatTeamLeaderStatus(teamName: string | null): string {
  const base = (teamName ?? "").trim().replace(/\s*팀$/, "");
  return base ? `팀장(${base} 팀)` : "운영진(팀장)";
}

// (rawRole, rawLevel, teamName, partName, managedTeamName) → 화면 3슬롯(teamLabel/partLabel/statusLabel).
function buildActivityLabels(input: {
  rawRole: string | null;
  rawLevel: string | null;
  teamName: string | null;
  partName: string | null;
  managedTeamName: string | null;
}): { teamLabel: string; partLabel: string; statusLabel: string } {
  const { rawRole, rawLevel, teamName, partName, managedTeamName } = input;

  // B. 운영진(팀장) — 팀/파트를 운영진 단위로 덮어쓰고, 상태에 관리 팀명을 붙인다.
  if (isTeamLeaderRole(rawRole)) {
    return {
      teamLabel: OPERATIONS_TEAM_LABEL,
      partLabel: OPERATIONS_PART_LABEL,
      statusLabel: formatTeamLeaderStatus(managedTeamName ?? teamName),
    };
  }
  // C. 운영진(앰배서더)
  if (isAmbassadorRole(rawRole)) {
    return {
      teamLabel: OPERATIONS_TEAM_LABEL,
      partLabel: OPERATIONS_PART_LABEL,
      statusLabel: "앰배서더",
    };
  }

  // A. 일반/심화 크루 — 팀/파트 그대로, 상태는 등급/역할로 판정.
  const teamLabel = firstNonEmpty(teamName) ?? "-";
  const partLabel = firstNonEmpty(partName) ?? "-";
  let statusLabel = "일반";
  if (isPartLeaderRole(rawRole, rawLevel)) statusLabel = "심화(파트장)";
  else if (isAgentRole(rawRole, rawLevel)) statusLabel = "심화(에이전트)";
  return { teamLabel, partLabel, statusLabel };
}

// 시즌 [seasonStart, seasonEnd] 와 [start, end] 윈도가 겹치는가 (date 부분만 비교).
function windowOverlapsSeason(
  start: string | null,
  end: string | null,
  seasonStart: string,
  seasonEnd: string,
): boolean {
  const ws = (start ?? "").slice(0, 10);
  if (!ws) return false;
  if (ws > seasonEnd) return false; // 시즌 종료 후 시작
  const we = end ? end.slice(0, 10) : null;
  if (we && we < seasonStart) return false; // 시즌 시작 전 종료
  return true;
}

type TeamPartRow = {
  id: string | null;
  team_id: string | null;
  part_id: string | null;
  joined_at: string | null;
  left_at: string | null;
  managed_team_id: string | null;
};

type RoleHistoryRow = {
  role: string | null;
  started_at: string | null;
  ended_at: string | null;
};

type ActivitySource = {
  id: string;
  teamName: string | null;
  partName: string | null;
  managedTeamName: string | null;
  rawRole: string | null;
  rawLevel: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

async function computeSeasonActivityStatuses(
  userId: string,
  season: Season | null,
): Promise<SeasonActivityStatus[]> {
  if (!season) return []; // 현재 시즌 판별 불가(달력 갭) → 빈 배열.
  const seasonStart = season.startDate;
  const seasonEnd = season.endDate;

  try {
    const [teamPartsRes, roleHistRes, membershipRes, profileRes] =
      await Promise.all([
        supabaseAdmin
          .from("user_team_parts")
          .select("id,team_id,part_id,joined_at,left_at,managed_team_id")
          .eq("user_id", userId),
        supabaseAdmin
          .from("user_role_history")
          .select("role,started_at,ended_at")
          .eq("user_id", userId),
        supabaseAdmin
          .from("user_memberships")
          .select("team_name,part_name,membership_level,is_current,updated_at")
          .eq("user_id", userId),
        supabaseAdmin
          .from("user_profiles")
          .select("role,current_team_name,current_part_name")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

    if (teamPartsRes.error)
      console.warn("[weekly-growth][area-8] user_team_parts lookup failed", {
        message: teamPartsRes.error.message,
      });
    if (roleHistRes.error)
      console.warn("[weekly-growth][area-8] user_role_history lookup failed", {
        message: roleHistRes.error.message,
      });
    if (membershipRes.error)
      console.warn("[weekly-growth][area-8] user_memberships lookup failed", {
        message: membershipRes.error.message,
      });
    if (profileRes.error)
      console.warn("[weekly-growth][area-8] user_profiles lookup failed", {
        message: profileRes.error.message,
      });

    const teamParts = (teamPartsRes.data ?? []) as TeamPartRow[];
    const roleHistory = (roleHistRes.data ?? []) as RoleHistoryRow[];

    // 현재 등급(level)/팀/파트 — user_memberships(is_current 우선, 그다음 updated_at 최신).
    type MemRow = {
      team_name: string | null;
      part_name: string | null;
      membership_level: string | null;
      is_current: boolean | null;
      updated_at: string | null;
    };
    // 고객앱과 동일한 membership 선택 resolver(team_name 보유 행 우선) — adminCrewData.pickBestMembership
    // 와 동일 규칙. is_current=true 라도 team_name 이 NULL 이면 team_name 보유 행을 우선해 팀/파트가
    // 비지 않게 한다(area-8 상태 이력의 fallback 단일 항목에도 동일 적용).
    const memRank = (r: MemRow): number => {
      const cur = Boolean(r.is_current);
      const team = typeof r.team_name === "string" && r.team_name.trim() !== "";
      if (cur && team) return 0;
      if (team) return 1;
      if (cur) return 2;
      return 3;
    };
    const memberships = ((membershipRes.data ?? []) as MemRow[]).slice().sort(
      (a, b) => {
        const rankDelta = memRank(a) - memRank(b);
        if (rankDelta !== 0) return rankDelta;
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      },
    );
    const currentMembership = memberships[0] ?? null;
    const profileRow =
      (profileRes.data as {
        role: string | null;
        current_team_name: string | null;
        current_part_name: string | null;
      } | null) ?? null;
    const currentLevel = currentMembership?.membership_level ?? null;
    // 고객앱 resolver 규칙 5: membership 행에 team/part 가 없으면 profile 의 current_* 로 폴백.
    const currentTeamName = firstNonEmpty(
      currentMembership?.team_name,
      profileRow?.current_team_name,
    );
    const currentPartName = firstNonEmpty(
      currentMembership?.part_name,
      profileRow?.current_part_name,
    );
    const currentRole = profileRow?.role ?? null;

    // 윈도 시작 시점에 활성인 role (started_at <= winStart < ended_at). 최신 started_at 우선.
    const resolveRoleForWindow = (winStart: string | null): string | null => {
      if (!winStart || roleHistory.length === 0) return null;
      const ws = winStart.slice(0, 10);
      const active = roleHistory
        .filter((r) => {
          const s = (r.started_at ?? "").slice(0, 10);
          if (!s || s > ws) return false;
          const e = r.ended_at ? r.ended_at.slice(0, 10) : null;
          return e === null || e > ws;
        })
        .sort((a, b) =>
          (b.started_at ?? "").localeCompare(a.started_at ?? ""),
        );
      return active[0]?.role ?? null;
    };

    // teams / parts 라벨 일괄 조회.
    const teamIds = new Set<string>();
    const partIds = new Set<string>();
    for (const tp of teamParts) {
      if (tp.team_id) teamIds.add(tp.team_id);
      if (tp.managed_team_id) teamIds.add(tp.managed_team_id);
      if (tp.part_id) partIds.add(tp.part_id);
    }
    const teamNameById = new Map<string, string>();
    const partNameById = new Map<string, string>();
    if (teamIds.size > 0) {
      const { data } = await supabaseAdmin
        .from("teams")
        .select("id,name")
        .in("id", [...teamIds]);
      for (const t of (data ?? []) as { id: string; name: string | null }[]) {
        if (t.id && t.name) teamNameById.set(t.id, t.name);
      }
    }
    if (partIds.size > 0) {
      const { data } = await supabaseAdmin
        .from("parts")
        .select("id,name")
        .in("id", [...partIds]);
      for (const p of (data ?? []) as { id: string; name: string | null }[]) {
        if (p.id && p.name) partNameById.set(p.id, p.name);
      }
    }

    // 시즌과 겹치는 user_team_parts → 활동 source.
    const sources: ActivitySource[] = [];
    for (const tp of teamParts) {
      if (!windowOverlapsSeason(tp.joined_at, tp.left_at, seasonStart, seasonEnd))
        continue;
      sources.push({
        id: tp.id ?? `tp-${tp.team_id ?? "?"}-${tp.joined_at ?? "?"}`,
        teamName: tp.team_id ? teamNameById.get(tp.team_id) ?? null : null,
        partName: tp.part_id ? partNameById.get(tp.part_id) ?? null : null,
        managedTeamName: tp.managed_team_id
          ? teamNameById.get(tp.managed_team_id) ?? null
          : null,
        // 역할: 윈도 시작 시점 role 이력 우선, 없으면 현재 role(profile).
        rawRole: resolveRoleForWindow(tp.joined_at) ?? currentRole,
        rawLevel: currentLevel,
        startedAt: tp.joined_at ?? null,
        endedAt: tp.left_at ?? null,
      });
    }

    // fallback: 이력 row 가 없으면 현재 membership/profile 로 단일 항목.
    if (sources.length === 0) {
      // 현재 활동 신호(팀/파트/등급/역할)가 하나도 없으면 표시할 궤적이 없다 → [].
      if (
        !firstNonEmpty(currentTeamName, currentPartName, currentLevel, currentRole)
      ) {
        return [];
      }
      sources.push({
        id: `current-${userId}`,
        teamName: currentTeamName,
        partName: currentPartName,
        managedTeamName: null,
        rawRole: currentRole,
        rawLevel: currentLevel,
        startedAt: null,
        endedAt: null,
      });
    }

    // 정렬: startedAt ASC, null 은 마지막.
    sources.sort((a, b) => {
      const sa = a.startedAt;
      const sb = b.startedAt;
      if (sa && sb) return sa < sb ? -1 : sa > sb ? 1 : 0;
      if (sa && !sb) return -1;
      if (!sa && sb) return 1;
      return 0;
    });

    // 라벨 산출 + 연속 동일(team/part/status) 병합.
    const merged: SeasonActivityStatus[] = [];
    for (const s of sources) {
      const labels = buildActivityLabels({
        rawRole: s.rawRole,
        rawLevel: s.rawLevel,
        teamName: s.teamName,
        partName: s.partName,
        managedTeamName: s.managedTeamName,
      });
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.teamLabel === labels.teamLabel &&
        prev.partLabel === labels.partLabel &&
        prev.statusLabel === labels.statusLabel
      ) {
        // 병합: 진행 중(null endedAt)이면 계속 열린 채로, 아니면 더 늦은 종료일로 확장.
        if (prev.endedAt !== null) {
          prev.endedAt =
            s.endedAt === null
              ? null
              : s.endedAt > prev.endedAt
                ? s.endedAt
                : prev.endedAt;
        }
        continue;
      }
      merged.push({
        id: s.id,
        order: 0, // 아래에서 1-base 재부여
        teamLabel: labels.teamLabel,
        partLabel: labels.partLabel,
        statusLabel: labels.statusLabel,
        rawRole: s.rawRole,
        rawMembershipLevel: s.rawLevel,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      });
    }

    return merged
      .slice(0, MAX_SEASON_ACTIVITY_STATUSES)
      .map((e, i) => ({ ...e, order: i + 1 }));
  } catch (error) {
    console.warn("[weekly-growth][area-8] computeSeasonActivityStatuses failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
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

  // 진입 화면 시즌 요약 — 현재 시즌(달력) 단일 정보. 사용자 데이터와 무관하게 항상 산출.
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentSeason = getSeasonForDate(todayIso);
  const seasonSummary = currentSeason
    ? buildSeasonSummary(currentSeason, todayIso)
    : null;
  const currentSeasonKey = currentSeason ? seasonDbKey(currentSeason) : null;

  if (!crew.userId) {
    return {
      currentWeekInfo,
      growthSummary: emptyGrowthSummary(),
      weeklyCards: [],
      seasonGrowthRates: [],
      seasonSummary,
      seasonPointSummary: { star: 0, shield: 0, lightning: 0 },
      seasonActivityStatuses: [],
    };
  }

  const tCurrentWeek = Date.now();
  // 클린 파이프라인: 카드(resolved)를 먼저 만든 뒤 그 카드로 요약을 fold 한다.
  //   → growthSummary 와 weeklyCards 가 동일 ResolvedWeek 소스를 공유(수동 보정 불필요).
  const weeklyResult = await computeWeeklyCards(
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
  );
  const weeklyCards = weeklyResult.cards;
  const growthSummary = await computeGrowthSummary(crew.userId, weeklyCards);
  const tCards = Date.now();
  console.log(
    "[weekly-cards][timing] getWeeklyGrowth",
    `crew=${tCrew - t0}ms`,
    `currentWeek=${tCurrentWeek - tCrew}ms`,
    `summary+cards=${tCards - tCurrentWeek}ms`,
    `total=${tCards - t0}ms`,
  );

  const seasonGrowthRates = computeSeasonGrowthRates(weeklyCards);
  const seasonPointSummary = computeSeasonPointSummary(
    weeklyCards,
    currentSeasonKey,
  );
  // area-8-season-status — 현재 시즌 팀/파트/상태 활동 이력. seasonSummary 와 동일하게
  // live 경로(snapshot 미사용)이며 현재 시즌(currentSeason) 범위로 필터한다.
  const seasonActivityStatuses = await computeSeasonActivityStatuses(
    crew.userId,
    currentSeason,
  );

  return {
    currentWeekInfo,
    growthSummary,
    weeklyCards,
    seasonGrowthRates,
    seasonSummary,
    seasonPointSummary,
    seasonActivityStatuses,
  };
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
  // (v11 적용 시점 분리) 실사용자 과거(effectiveFrom 이전) 주차 중 verdict 상 fail 인데
  // 보호되어 update 하지 않은 주차 키 — dry-run 성격의 관찰값.
  protectedWeekKeys: string[];
  isTestUser: boolean;
  effectiveFromDate: string;
  userId: string;
  scannedSuccessWeeks: number; // status='success' 후보 주차 수
  flippedToFail: number; // dryRun=false: 실제 success→fail 갱신 수 / dryRun=true: 변경 예정 수
  flippedWeekKeys: string[]; // "year-week_number"
  dryRun: boolean; // true 면 DB write 없이 변경 예정만 계산
};

// 사용자 테스트 여부 단건 조회 — SoT = public.test_user_markers (lib/testUsers.isTestUser).
//   (2026-06 정책: display_name '%T%' 휴리스틱 제거. 이름 기반 판정 금지 — marker 등재만 기준.)
//   개인 sync 의 write-gate(테스트 유저는 항상 write 허용)와 v11 결과 보고용 isTestUser 필드에 사용.
//   조회 실패 시 false(실사용자, 보수적) — 과거 데이터 보호가 기본(isMarkedTestUser 내부에서도 동일).
export async function fetchIsTestUser(userId: string): Promise<boolean> {
  return isMarkedTestUser(userId);
}

export async function syncExperienceGrowthWeekStatuses(
  userId: string,
  opts: { now?: number; dryRun?: boolean; effectiveFromDate?: string } = {},
): Promise<ExperienceGrowthSyncResult> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  // 허브/라인 체계 적용 시점 (2026-06-05 개정 — 사용자 유형 무관):
  //   - effectiveFromDate(기본 CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM = 2026 여름 W1) 이후 시작
  //     주차만 신정책 verdict + write. 레거시(그 이전) 주차는 verdict 기준과 무관하게
  //     **update 금지**(소급 강등 금지 — 테스터 포함 전원). 레거시 주차의 성공/실패 SoT 는
  //     마이그레이션으로 정렬된 user_week_statuses 그대로다. would-flip 은 protectedWeekKeys
  //     로 dry-run 집계만 한다.
  const effectiveFromDate =
    opts.effectiveFromDate ?? CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  const isTestUser = await fetchIsTestUser(userId);
  const empty: ExperienceGrowthSyncResult = {
    userId,
    scannedSuccessWeeks: 0,
    flippedToFail: 0,
    flippedWeekKeys: [],
    protectedWeekKeys: [],
    isTestUser,
    effectiveFromDate,
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
  //   신정책(항상-개설) 적용 주차 = effectiveFrom 이후 시작 주차 (사용자 유형 무관 —
  //   테스터 전 주차 예외 폐기, 2026-06-05 레거시 통합 정책).
  //   (성공 row 는 모두 공표·과거 주차이므로 별도 published/현재주 게이트는 아래 단계가 담당.)
  const alwaysOpenWeekIds = new Set<string>();
  for (const r of successRows) {
    const weekId = weekIdByStart.get(r.week_start_date);
    if (!weekId) continue;
    if (r.week_start_date >= effectiveFromDate) {
      alwaysOpenWeekIds.add(weekId);
    }
  }
  const verdictMap = await fetchExperienceRequiredSlotStatusByWeek(
    userId,
    weekCardIds,
    now,
    { alwaysOpenWeekIds },
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
  const protectedWeekKeys: string[] = [];
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

    // 레거시(허브 도입 전) 주차 보호: effectiveFrom 이전 주차는 verdict 와 무관하게
    // **update 금지**(테스터 포함 전원) — 소급 success→fail 강등 방지. 레거시 성공/실패 SoT 는
    // 마이그레이션으로 정렬된 uws 그대로. would-flip 만 protected 로 집계(관찰용).
    if (r.week_start_date < effectiveFromDate) {
      protectedWeekKeys.push(`${r.year}-${r.week_number}`);
      continue;
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

  // 6. user_week_statuses 가 실제로 바뀐 경우 파생 캐시(user_growth_stats)를 즉시 재집계.
  //    /crews 누적·승인 주차가 이 캐시를 읽으므로, 여기서 갱신하지 않으면 화면 간
  //    주차 수가 분기한다(stale 캐시 회귀의 근본 원인). best-effort — 실패해도 flip 은 유지.
  if (!dryRun && flippedWeekKeys.length > 0) {
    try {
      await recalcUserGrowthStats(userId);
    } catch (e) {
      console.error("[cluster4][sync] recalcUserGrowthStats failed", userId, e);
    }
  }

  return {
    userId,
    scannedSuccessWeeks: successRows.length,
    flippedToFail: flippedWeekKeys.length,
    flippedWeekKeys,
    protectedWeekKeys,
    isTestUser,
    effectiveFromDate,
    dryRun,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 개인(크루 단위) sync 정책 — 개발자 모드 기준.
//   - 테스트 사용자(test_user_markers 등재)          → 항상 write 허용.
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
  // 테스트 유저 판정 = test_user_markers(SoT). 이름('%T%') 기반 판정 폐기.
  const isTestUser = await fetchIsTestUser(crew.userId);

  let mode: "write" | "dry_run";
  let reason: string;
  if (isTestUser) {
    mode = "write";
    reason = "테스트 사용자(test_user_markers) — 항상 반영 허용";
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
  scope: "all" | "test"; // 운영 전체 vs 테스트 사용자(test_user_markers 등재)만
  dryRun: boolean; // true 면 DB write 없이 변경 예정만 계산
  usersScanned: number; // 이 scope 에서 success 보유 대상 사용자 수
  usersFlipped: number; // 1건 이상 fail 전환(예정)된 사용자 수
  totalFlippedToFail: number; // 전체 success→fail 전환(예정) 주차 수
  // (v11) 실사용자 과거(effectiveFrom 이전) 보호로 update 가 차단된 주차 총수 — 관찰값.
  totalProtected: number;
  results: ExperienceGrowthSyncResult[]; // 변경(예정) 또는 보호 발생한 사용자만
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

async function syncExperienceGrowthForUserIds(
  scope: "all" | "test",
  userIds: string[],
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncAllResult> {
  const dryRun = opts.dryRun ?? false;
  const results: ExperienceGrowthSyncResult[] = [];
  let totalFlippedToFail = 0;
  let totalProtected = 0;
  let usersFlipped = 0;
  for (const uid of userIds) {
    const r = await syncExperienceGrowthWeekStatuses(uid, { now: opts.now, dryRun });
    totalProtected += r.protectedWeekKeys.length;
    if (r.flippedToFail > 0) usersFlipped += 1;
    // 변경(예정) 또는 과거 보호 발생 사용자만 상세 수집 (no-op 사용자는 생략).
    if (r.flippedToFail > 0 || r.protectedWeekKeys.length > 0) {
      results.push(r);
      totalFlippedToFail += r.flippedToFail;
    }
  }
  return {
    scope,
    dryRun,
    usersScanned: userIds.length,
    usersFlipped,
    totalFlippedToFail,
    totalProtected,
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

// 테스트용: test_user_markers 등재 테스트 사용자만 대상 (실사용자 오적용 방지·SoT 일치).
export async function syncTestExperienceGrowthWeekStatuses(
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<ExperienceGrowthSyncAllResult> {
  const [successIds, testIds] = await Promise.all([
    fetchUsersWithSuccessWeeks(),
    fetchTestUserMarkerIds(),
  ]);
  const userIds = successIds.filter((id) => testIds.has(id));
  return syncExperienceGrowthForUserIds("test", userIds, opts);
}
