import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
  is_current_week: boolean;
};

type SeasonWeekConflictDto = {
  season_key: string;
  week_id: string;
  week_number: number | null;
  week_start_date: string | null;
  db_is_official_rest: boolean;
  calendar_is_official_rest: boolean;
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
  if (weekNumber > seasonWeeks) return true;

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

      const restKey = officialRestKey(week.iso_year, week.iso_week);
      const dbOfficialRest =
        week.is_official_rest === true ||
        (restKey != null && officialRestKeys.has(restKey));
      const calendarRest = calendarOfficialRest(
        season.season_type,
        week.week_number,
      );

      if (calendarRest != null && calendarRest !== dbOfficialRest) {
        conflicts.push({
          season_key: season.season_key,
          week_id: week.id,
          week_number: week.week_number,
          week_start_date: week.start_date,
          db_is_official_rest: dbOfficialRest,
          calendar_is_official_rest: calendarRest,
          reason:
            "seasonCalendar.ts derived official-rest rule differs from weeks/official_rest_weeks.",
        });
      }

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
        is_official_rest: dbOfficialRest,
        is_current_week: isCurrentWeek(week.start_date, week.end_date, today),
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
