import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
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

type SeasonDto = {
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
};

type OfficialRestWeekRow = {
  year: number;
  week_number: number;
};

type SeasonWeekDto = {
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
  // 공식 휴식 판정 출처(복수 가능). 최종 is_official_rest = season_rule ∨ date_period.
  // legacy_iso_week 는 표시 전용으로 판정에 반영되지 않는다.
  official_rest_sources: OfficialRestSource[];
  is_current_week: boolean;
  // 전환 주차: 시즌 정규 주수(seasonWeeks)를 초과하는 +1 주차(시즌당 최대 1주).
  // 공식 휴식이 아니며 시즌 end_date 범위 안(마지막 주)에 위치한다. 직전 시즌에 귀속.
  is_transition: boolean;
};

type SeasonWeekConflictDto = {
  season_key: string;
  week_id: string;
  week_number: number | null;
  week_start_date: string | null;
  // 신규 판정(season_rule ∨ date_period) 과 legacy(official_rest_weeks/weeks.is_official_rest) 의 불일치.
  resolved_is_official_rest: boolean;
  legacy_is_official_rest: boolean;
  reason: string;
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
  // 여름/겨울은 시험기간 휴식이 없어 마지막 +1주는 전환 주차일 뿐이며 여기서 false.
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

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const { data: seasonData, error: seasonError } = await supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: true });

    if (seasonError) {
      return Response.json(
        { success: false, error: seasonError.message },
        { status: 500 },
      );
    }

    const seasons = (seasonData ?? []) as SeasonDefinitionRow[];
    const seasonDtos: SeasonDto[] = seasons.map((season) => ({
      season_key: season.season_key,
      season_label: season.season_label,
      season_name: seasonName(season),
      season_start_date: season.start_date,
      season_end_date: season.end_date,
    }));

    if (seasons.length === 0) {
      return Response.json({
        success: true,
        data: {
          seasons: [],
          rows: [],
          conflicts: [],
          generatedAt: new Date().toISOString(),
        },
      });
    }

    const seasonKeys = seasons.map((season) => season.season_key);
    const { data: weekData, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select(
        "id,season_key,week_number,start_date,end_date,is_official_rest,iso_year,iso_week",
      )
      .in("season_key", seasonKeys)
      .order("start_date", { ascending: true });

    if (weekError) {
      return Response.json(
        { success: false, error: weekError.message },
        { status: 500 },
      );
    }

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
        return Response.json(
          { success: false, error: officialError.message },
          { status: 500 },
        );
      }

      for (const row of (officialData ?? []) as OfficialRestWeekRow[]) {
        officialRestKeys.add(`${row.year}::${row.week_number}`);
      }
    }

    // 신규 SoT: 활성 official_rest_periods. 테이블 미생성이면 [] 로 graceful degrade.
    const activePeriods = await fetchActiveRestPeriods();

    const seasonByKey = new Map(
      seasons.map((season) => [season.season_key, season]),
    );
    const today = new Date().toISOString().slice(0, 10);
    const rows: SeasonWeekDto[] = [];
    const conflicts: SeasonWeekConflictDto[] = [];

    for (const week of weeks) {
      if (!week.season_key) continue;
      const season = seasonByKey.get(week.season_key);
      if (!season) continue;

      // legacy(표시 전용): official_rest_weeks(year, iso_week) 또는 weeks.is_official_rest.
      const restKey = officialRestKey(week.iso_year, week.iso_week);
      const legacyRest =
        week.is_official_rest === true ||
        (restKey != null && officialRestKeys.has(restKey));

      // season_rule: seasonCalendar 규칙(시험기간). null(판정 불가) 은 false 취급.
      const seasonRuleRest =
        calendarOfficialRest(season.season_type, week.week_number) === true;

      // date_period: 활성 official_rest_periods 와 주차 날짜 범위 overlap.
      // 다중 주차 겹침(옵션 A) — 겹치는 모든 주차가 휴식이 된다.
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

      // 신규 판정과 legacy 가 어긋나면 정합 점검용 conflict 로 노출(데이터 정리 도구).
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

      // 전환 주차 판정(파생): 시즌 정규 주수(seasonWeeks)를 초과하는 +1 주차 = 전환.
      // 시즌 end_date 는 전환 주차를 포함하므로 날짜 비교로는 잡히지 않는다(week_number 기준).
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
        is_current_week: isCurrentWeek(week.start_date, week.end_date, today),
        is_transition: isTransition,
      });
    }

    return Response.json({
      success: true,
      data: {
        seasons: seasonDtos,
        rows,
        conflicts,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[admin/season-weeks GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load season weeks",
      },
      { status: 500 },
    );
  }
}
