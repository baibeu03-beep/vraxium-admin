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
  type ExperienceGrowthVerdictDto,
  type WeekResultStatus,
  type CurrentWeekInfo,
  type GrowthSummary,
  type SeasonGrowthRate,
  type RestReason,
  type EndStatus,
} from "@/lib/cluster4WeeklyGrowthTypes";
import {
  fetchInfoLineCountsByWeek,
  fetchExperienceLineCountsByWeek,
  fetchCompetencyLineCountsByWeek,
  fetchInfoLineSuccessCountsByWeek,
  fetchLineSuccessCountsByWeek,
  fetchCareerProjectCountsByWeek,
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
): Promise<{ cards: WeeklyCardDto[]; flippedToFail: number }> {
  const { teamLabel, partLabel, activityStatus } = crewMeta;
  // 1. 사용자 주차 상태 조회 (최신순)
  const { data: uwsData, error: uwsErr } = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false });

  if (uwsErr || !uwsData || uwsData.length === 0) {
    return { cards: [], flippedToFail: 0 };
  }
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
  let experienceLineMap = new Map<string, number>();
  let competencyLineMap = new Map<string, number>();
  let infoSuccessMap = new Map<string, number>();
  let abilitySuccessMap = new Map<string, number>();
  let experienceSuccessMap = new Map<string, number>();
  let careerSuccessMap = new Map<string, number>();
  let careerProjectMap = new Map<string, number>();
  // 실무 경험 필수 슬롯(도출/분석/평가) verdict: weekId → verdict. (강화율/평점/5슬롯 로직과 독립)
  let experienceVerdictMap = new Map<string, ExperienceGrowthVerdict>();

  if (weekCardIds.length > 0) {
    const [
      infoMap,
      experienceMap,
      competencyMap,
      infoSuccess,
      abilitySuccess,
      experienceSuccess,
      careerSuccess,
      careerMap,
      experienceVerdict,
    ] = await Promise.all([
      fetchInfoLineCountsByWeek(userId, weekCardIds),
      // experience 분모 A = 배정된 experience 라인 수 (info 와 동일 기준). 상수 2 대체.
      fetchExperienceLineCountsByWeek(userId, weekCardIds),
      // competency 분모 A = 배정된 competency 라인 수 (info/experience 와 동일 기준). 상수 1 대체.
      fetchCompetencyLineCountsByWeek(userId, weekCardIds),
      fetchInfoLineSuccessCountsByWeek(userId, weekCardIds),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "competency"),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "experience"),
      fetchLineSuccessCountsByWeek(userId, weekCardIds, "career"),
      fetchCareerProjectCountsByWeek(weekCardIds),
      // 필수 슬롯 verdict (성장 실패 판정 SoT). 강화율 분자/분모와 별개 source.
      fetchExperienceRequiredSlotStatusByWeek(userId, weekCardIds),
    ]);

    infoLineMap = infoMap;
    experienceLineMap = experienceMap;
    competencyLineMap = competencyMap;
    infoSuccessMap = infoSuccess;
    abilitySuccessMap = abilitySuccess;
    experienceSuccessMap = experienceSuccess;
    careerSuccessMap = careerSuccess;
    careerProjectMap = careerMap;
    experienceVerdictMap = experienceVerdict;
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
    const wkId = weeksByDate.get(w.week_start_date)?.id ?? null;
    const verdict = wkId ? experienceVerdictMap.get(wkId) : undefined;
    const isCurrent = Boolean(
      currentSeason &&
        currentWeek &&
        w.year === new Date().getUTCFullYear() &&
        w.week_start_date === currentWeek.weekStart,
    );
    // 누적 성공 = DB success, 단 필수 슬롯 verdict=fail 이면(현재주 제외) 성공에서 제외 →
    // 배지(resultStatus)·누적·요약이 동일 기준으로 일관되게 움직인다.
    let countsAsSuccess = w.status === "success";
    if (countsAsSuccess && verdict?.status === "fail" && !isCurrent) {
      countsAsSuccess = false;
    }
    if (countsAsSuccess) cumulativeSuccess++;
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
  // DB success → 필수 슬롯 verdict=fail 로 전환된 주차 수 (요약 approved/failed 보정용).
  let flippedToFail = 0;

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

    // 라인 가용 수(A)는 동적 조회. 이행 수(B)는 4개 part 모두 target+마감 기준 success.
    const avail = isRest
      ? { info: 0, ability: 0, experience: 0, career: 0 }
      : buildWeekAvailability(
          weekCardId,
          infoLineMap,
          careerProjectMap,
          organization,
          experienceLineMap,
          competencyLineMap,
        );

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
