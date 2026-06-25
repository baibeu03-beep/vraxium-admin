// 시즌·주차 SoT 로더 — /api/admin/season-weeks GET 의 데이터 구성 본체(서버 전용).
//
// 라우트(GET)와 검증 스크립트가 동일 함수를 호출해 "direct == HTTP" 를 보장한다.
// 인증/HTTP 응답 포장은 라우트가 책임지고, 여기서는 DB 조회 + 판정만 한다.
// (snapshot·demoUserId·일반 사용자 경로와 무관 — 순수 시즌/주차 메타 데이터.)

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import {
  matchOfficialRestPeriods,
  resolveOfficialRest,
  type OfficialRestSource,
} from "@/lib/officialRestPeriodsTypes";

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  start_date: string | null;
  end_date: string | null;
};

export type SeasonDto = {
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
  is_official_rest: boolean | null;
  iso_year: number | null;
  iso_week: number | null;
  holiday_name: string | null;
};

type OfficialRestWeekRow = {
  year: number;
  week_number: number;
};

export type SeasonWeekDto = {
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
  week_id: string;
  week_number: number | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  is_official_rest: boolean;
  official_rest_sources: OfficialRestSource[];
  is_current_week: boolean;
  is_transition: boolean;
  holiday_name: string | null;
};

export type SeasonWeekConflictDto = {
  season_key: string;
  week_id: string;
  week_number: number | null;
  week_start_date: string | null;
  resolved_is_official_rest: boolean;
  legacy_is_official_rest: boolean;
  reason: string;
};

export type SeasonWeeksData = {
  seasons: SeasonDto[];
  rows: SeasonWeekDto[];
  conflicts: SeasonWeekConflictDto[];
};

const SEASON_TYPE_LABEL: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

function officialRestKey(year: number | null, week: number | null) {
  if (year == null || week == null) return null;
  return `${year}::${week}`;
}

function seasonName(season: SeasonDefinitionRow) {
  return (
    season.season_label ??
    (season.season_type ? SEASON_TYPE_LABEL[season.season_type] : null) ??
    season.season_key
  );
}

function calendarOfficialRest(
  seasonType: string | null,
  weekNumber: number | null,
): boolean | null {
  if (!seasonType || weekNumber == null) return null;

  const seasonWeeks = SEASON_WEEKS[seasonType];
  if (seasonWeeks == null) return null;

  // 전환 주차(정규 주수 +1)는 공식 휴식이 아니다 → is_transition 으로만 표시.
  if (weekNumber > seasonWeeks) return false;

  if (seasonType === "spring" || seasonType === "autumn") {
    if (weekNumber >= 6 && weekNumber <= 8) return true;
    if (weekNumber >= 14 && weekNumber <= 16) return true;
  }

  return false;
}

function isCurrentWeek(
  startDate: string | null,
  endDate: string | null,
  today: string,
) {
  if (!startDate || !endDate) return false;
  return startDate <= today && today <= endDate;
}

function isMissingOfficialRestTable(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /official_rest_weeks/i.test(message)
  );
}

export class SeasonWeeksLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonWeeksLoadError";
  }
}

// 시즌 정의 + 주차 + 공식 휴식 판정(season_rule ∨ date_period, legacy 표시)을 구성한다.
// today 미지정 시 서버 UTC 기준 오늘(라우트 기존 동작과 동일).
export async function loadSeasonWeeks(today?: string): Promise<SeasonWeeksData> {
  const { data: seasonData, error: seasonError } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date")
    .order("start_date", { ascending: true });

  if (seasonError) throw new SeasonWeeksLoadError(seasonError.message);

  const seasons = (seasonData ?? []) as SeasonDefinitionRow[];
  const seasonDtos: SeasonDto[] = seasons.map((season) => ({
    season_key: season.season_key,
    season_label: season.season_label,
    season_name: seasonName(season),
    season_start_date: season.start_date,
    season_end_date: season.end_date,
  }));

  if (seasons.length === 0) {
    return { seasons: [], rows: [], conflicts: [] };
  }

  const seasonKeys = seasons.map((season) => season.season_key);
  const { data: weekData, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,season_key,week_number,start_date,end_date,is_official_rest,iso_year,iso_week,holiday_name",
    )
    .in("season_key", seasonKeys)
    .order("start_date", { ascending: true });

  if (weekError) throw new SeasonWeeksLoadError(weekError.message);

  const weeks = (weekData ?? []) as WeekRow[];
  const officialRestKeys = new Set<string>();
  const officialRestPairs = Array.from(
    new Set(
      weeks
        .map((week) => officialRestKey(week.iso_year, week.iso_week))
        .filter((key): key is string => Boolean(key)),
    ),
  );

  if (officialRestPairs.length > 0) {
    const years = Array.from(
      new Set(
        weeks
          .map((week) => week.iso_year)
          .filter((year): year is number => year != null),
      ),
    );

    const { data: officialData, error: officialError } = await supabaseAdmin
      .from("official_rest_weeks")
      .select("year,week_number")
      .in("year", years);

    if (officialError && !isMissingOfficialRestTable(officialError)) {
      throw new SeasonWeeksLoadError(officialError.message);
    }

    for (const row of (officialData ?? []) as OfficialRestWeekRow[]) {
      officialRestKeys.add(`${row.year}::${row.week_number}`);
    }
  }

  // 신규 SoT: 활성 official_rest_periods. 테이블 미생성이면 [] 로 graceful degrade.
  const activePeriods = await fetchActiveRestPeriods();

  const seasonByKey = new Map(seasons.map((season) => [season.season_key, season]));
  const todayIso = today ?? new Date().toISOString().slice(0, 10);
  const rows: SeasonWeekDto[] = [];
  const conflicts: SeasonWeekConflictDto[] = [];

  for (const week of weeks) {
    if (!week.season_key) continue;
    const season = seasonByKey.get(week.season_key);
    if (!season) continue;

    const restKey = officialRestKey(week.iso_year, week.iso_week);
    const legacyRest =
      week.is_official_rest === true ||
      (restKey != null && officialRestKeys.has(restKey));

    const seasonRuleRest =
      calendarOfficialRest(season.season_type, week.week_number) === true;

    const matchedDatePeriods =
      week.start_date && week.end_date
        ? matchOfficialRestPeriods(
            { startDate: week.start_date, endDate: week.end_date },
            activePeriods,
          ).length
        : 0;

    const { isOfficialRest, sources } = resolveOfficialRest({
      seasonRuleRest,
      matchedDatePeriods,
      legacyRest,
    });

    if (legacyRest !== isOfficialRest) {
      conflicts.push({
        season_key: season.season_key,
        week_id: week.id,
        week_number: week.week_number,
        week_start_date: week.start_date,
        resolved_is_official_rest: isOfficialRest,
        legacy_is_official_rest: legacyRest,
        reason:
          "신규 판정(season_rule ∨ date_period)이 legacy(official_rest_weeks/weeks.is_official_rest)와 다릅니다.",
      });
    }

    const transitionSeasonWeeks =
      season.season_type != null ? SEASON_WEEKS[season.season_type] : null;
    const isTransition = Boolean(
      transitionSeasonWeeks != null &&
        week.week_number != null &&
        week.week_number > transitionSeasonWeeks,
    );

    rows.push({
      season_key: season.season_key,
      season_label: season.season_label,
      season_name: seasonName(season),
      season_start_date: season.start_date,
      season_end_date: season.end_date,
      week_id: week.id,
      week_number: week.week_number,
      week_label:
        week.week_number == null ? "주차 미지정" : `${week.week_number}주차`,
      week_start_date: week.start_date,
      week_end_date: week.end_date,
      is_official_rest: isOfficialRest,
      official_rest_sources: sources,
      is_current_week: isCurrentWeek(week.start_date, week.end_date, todayIso),
      is_transition: isTransition,
      holiday_name: week.holiday_name,
    });
  }

  return { seasons: seasonDtos, rows, conflicts };
}
