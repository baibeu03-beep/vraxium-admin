import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  getSeasonForDate,
  getSeasonCalendar,
  getCalendarWeekStatus,
  seasonDbKey,
  type Season,
} from "@/lib/seasonCalendar";
import { getGraduationThreshold } from "@/lib/pointLabels";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  WEEK_STATUS_LABEL,
  formatDateRange,
  type WeeklyGrowthDto,
  type WeeklyGrowthStatus,
  type WeeklyCardDto,
  type WeeklyCardLineBreakdown,
  type WeekResultStatus,
  type CurrentWeekInfo,
  type GrowthSummary,
  type SeasonGrowthRate,
  type RestReason,
  type EndStatus,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  fetchInfoLineCountsByWeek,
  fetchInfoLineSuccessCountsByWeek,
  fetchLineSuccessCountsByWeek,
  fetchCareerProjectCountsByWeek,
  buildWeekAvailability,
  roundGrowthRate,
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

function getISOWeekInfo(iso: string): { isoYear: number; isoWeek: number } {
  const date = new Date(`${iso}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7,
  );
  return { isoYear, isoWeek };
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
// Holiday detection from official_rest_weeks DB table
// ─────────────────────────────────────────────────────────────────────
function mapHolidayReason(reason: string | null): RestReason {
  if (!reason) return null;
  const lower = reason.toLowerCase();
  if (lower.includes("추석") || lower.includes("chuseok")) return "chuseok";
  if (lower.includes("설") || lower.includes("구정") || lower.includes("lunar"))
    return "lunar_new_year";
  return null;
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
    status = "official_rest";
    restReason = null;
  } else {
    const { isoYear, isoWeek } = getISOWeekInfo(weekStart);
    const holidayRes = await supabaseAdmin
      .from("official_rest_weeks")
      .select("reason")
      .eq("year", isoYear)
      .eq("week_number", isoWeek)
      .maybeSingle();

    const hasHoliday = !holidayRes.error && holidayRes.data !== null;

    if (hasHoliday) {
      status = "official_rest";
      restReason = mapHolidayReason(
        (holidayRes.data as { reason: string | null })?.reason ?? null,
      );
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
      .select("year,week_number,status,season_key")
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
  };
  const weeks = weekRes.data as WeekRow[];

  if (weeks.length === 0) return emptyGrowthSummary();

  let approvedWeeks = 0;
  let failedWeeks = 0;
  let restWeeks = 0;

  for (const w of weeks) {
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
): Promise<WeeklyCardDto[]> {
  const { teamLabel, partLabel, activityStatus } = crewMeta;
  // 1. 사용자 주차 상태 조회 (최신순)
  const { data: uwsData, error: uwsErr } = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false });

  if (uwsErr || !uwsData || uwsData.length === 0) return [];
  const uwsRows = uwsData as UwsRow[];

  // 1b. season_definitions에서 season_label 조회
  const seasonKeys = [
    ...new Set(uwsRows.map((r) => r.season_key).filter(Boolean) as string[]),
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

  // 2. weeks 테이블에서 대응 row 조회 (start_date 매칭)
  const weekStartDates = uwsRows.map((r) => r.week_start_date);
  const { data: weeksData } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,iso_year,iso_week")
    .in("start_date", weekStartDates);

  const weeksByDate = new Map<string, WeeksRow>();
  if (weeksData) {
    for (const w of weeksData as WeeksRow[]) {
      if (w.start_date) weeksByDate.set(w.start_date, w);
    }
  }

  // 3. 주차별 포인트 조회
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

  // 4. 주차별 평판 카운트
  const weekCardIds = [...weeksByDate.values()].map((w) => w.id);
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
  let infoSuccessMap = new Map<string, number>();
  let abilitySuccessMap = new Map<string, number>();
  let experienceSuccessMap = new Map<string, number>();
  let careerSuccessMap = new Map<string, number>();
  let careerProjectMap = new Map<string, number>();

  if (weekCardIds.length > 0) {
    const [
      infoMap,
      infoSuccess,
      abilitySuccess,
      experienceSuccess,
      careerSuccess,
      careerMap,
    ] = await Promise.all([
      fetchInfoLineCountsByWeek(userId, weekCardIds),
      fetchInfoLineSuccessCountsByWeek(userId, weekCardIds),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "competency"),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "experience"),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "career"),
      fetchCareerProjectCountsByWeek(weekCardIds),
    ]);

    infoLineMap = infoMap;
    infoSuccessMap = infoSuccess;
    abilitySuccessMap = abilitySuccess;
    experienceSuccessMap = experienceSuccess;
    careerSuccessMap = careerSuccess;
    careerProjectMap = careerMap;
  }

  // 7. 현재 주 판별 (running/tallying)
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentSeason = getSeasonForDate(todayIso);
  const currentWeek = currentSeason
    ? getWeekInSeason(currentSeason, todayIso)
    : null;

  // 8. 누적 성공 주차 계산 (시간순 → 역순 매핑)
  const sorted = [...uwsRows].sort(
    (a, b) => a.year - b.year || a.week_number - b.week_number,
  );
  let cumulativeSuccess = 0;
  const accMap = new Map<string, number>();
  for (const w of sorted) {
    if (w.status === "success") cumulativeSuccess++;
    accMap.set(`${w.year}-${w.week_number}`, cumulativeSuccess);
  }

  // 누적 포인트 (FM score proxy). Null when no points row exists for this week
  // AND no prior week contributed — distinguishes "no data" from "real 0".
  let cumulativePoints = 0;
  let cumulativeAdvantages = 0;
  let anyPointsSeen = false;
  let anyAdvantagesSeen = false;
  const fmMap = new Map<string, number | null>();
  const cumAdvMap = new Map<string, number | null>();
  for (const w of sorted) {
    const key = `${w.year}-${w.week_number}`;
    const p = pointsMap.get(key);
    if (p) {
      cumulativePoints += p.points + p.advantages * 3 - p.penalty * 5;
      cumulativeAdvantages += p.advantages;
      anyPointsSeen = true;
      anyAdvantagesSeen = true;
    }
    fmMap.set(key, anyPointsSeen ? cumulativePoints : null);
    cumAdvMap.set(key, anyAdvantagesSeen ? cumulativeAdvantages : null);
  }

  const targetWeeks = organization
    ? getGraduationThreshold(organization)
    : 30;

  // 9. 카드 조립 (최신순)
  const cards: WeeklyCardDto[] = [];

  for (const uws of uwsRows) {
    const weekKey = `${uws.year}-${uws.week_number}`;
    const weeksRow = weeksByDate.get(uws.week_start_date);
    const pts = pointsMap.get(weekKey);
    const weekCardId = weeksRow?.id ?? null;

    // 시즌 정보 결정 (season_definitions.season_label 우선)
    const seasonKey = uws.season_key ?? weeksRow?.season_key ?? null;
    const seasonDef = seasonKey ? seasonLabelMap.get(seasonKey) : null;
    const seasonYear = seasonDef?.year ?? uws.year;
    const seasonName = seasonDef
      ? seasonDef.season_label
      : seasonKey
        ? formatSeasonKeyToLabel(seasonKey)
        : "";

    // 시즌 내 주차 번호
    const seasonWeekNumber = weeksRow?.week_number ?? null;

    // 주차 시작/종료일
    const startDate = weeksRow?.start_date ?? uws.week_start_date;
    const endDateMs = toMs(startDate) + 6 * DAY_MS;
    const endDate = weeksRow?.end_date ?? fmtDate(endDateMs);

    // 상태 결정: 현재 주이면 running/tallying
    let resultStatus: WeekResultStatus;
    const isCurrentWeek =
      currentSeason &&
      currentWeek &&
      uws.year === new Date().getUTCFullYear() &&
      startDate === currentWeek.weekStart;

    if (uws.status === "official_rest" && weeksRow?.is_official_rest === false) {
      resultStatus = isCurrentWeek ? "running" : "fail";
    } else if (isCurrentWeek && uws.status === "success") {
      resultStatus = "running";
    } else if (isCurrentWeek && uws.status === "fail") {
      resultStatus = "running";
    } else {
      resultStatus = uws.status as WeekResultStatus;
    }

    const isRest =
      resultStatus === "personal_rest" ||
      resultStatus === "official_rest";

    // 라인 가용 수(A)는 동적 조회. 이행 수(B)는 4개 part 모두 target+마감 기준 success.
    const avail = isRest
      ? { info: 0, ability: 0, experience: 0, career: 0 }
      : buildWeekAvailability(weekCardId, infoLineMap, careerProjectMap, organization);

    const lineBreakdown: WeeklyCardLineBreakdown = {
      // 4개 part 모두 B(completed) = target+마감 기준 success 수 (강화상태 success 와 동일 기준). 제출 무관.
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

    const displayWeekNum = seasonWeekNumber ?? uws.week_number;

    const fmRaw = fmMap.get(weekKey) ?? null;
    const cumAdvRaw = cumAdvMap.get(weekKey) ?? null;
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
      accumulatedApprovedWeeks: accMap.get(weekKey) ?? 0,
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
    });
  }

  return cards;
}

// ─────────────────────────────────────────────────────────────────────
// 시즌 성장률: 주차별 평균이 아니라 시즌 전체 합산 기반
//   rate = ceil(totalCompleted / totalAvailable × 100)
// ─────────────────────────────────────────────────────────────────────
function computeSeasonGrowthRates(cards: WeeklyCardDto[]): SeasonGrowthRate[] {
  const map = new Map<string, { label: string; completed: number; available: number }>();

  for (const c of cards) {
    if (!c.seasonKey) continue;
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
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return null;

  const currentWeekInfo = await computeCurrentWeekInfo();

  if (!crew.userId) {
    return {
      currentWeekInfo,
      growthSummary: emptyGrowthSummary(),
      weeklyCards: [],
      seasonGrowthRates: [],
    };
  }

  const [growthSummary, weeklyCards] = await Promise.all([
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
