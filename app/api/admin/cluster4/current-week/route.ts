import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getSeasonForDate,
  getCalendarWeekStatus,
  seasonDbKey,
} from "@/lib/seasonCalendar";

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

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const season = getSeasonForDate(todayIso);

    if (!season) {
      return Response.json(
        { success: false, error: "현재 시즌을 찾을 수 없습니다" },
        { status: 500 },
      );
    }

    const seasonStartMs = toMs(season.startDate);
    const dateMs = toMs(todayIso);
    const weekIndex = Math.floor((dateMs - seasonStartMs) / (7 * DAY_MS));
    const weekNumber = weekIndex + 1;
    const weekStartMs = seasonStartMs + weekIndex * 7 * DAY_MS;
    const weekEndMs = weekStartMs + 6 * DAY_MS;
    const weekStart = fmtDate(weekStartMs);
    const weekEnd = fmtDate(weekEndMs);

    const calendarStatus = getCalendarWeekStatus(
      season.type,
      weekNumber,
      season.seasonWeeks,
    );

    const isOfficialRest =
      calendarStatus === "official_rest" || calendarStatus === "transition";

    // Look up week row by ISO year/week
    const { isoYear, isoWeek } = getISOWeekInfo(weekStart);
    const { data: weekRow } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date,end_date,season_key,is_official_rest,week_number")
      .eq("iso_year", isoYear)
      .eq("iso_week", isoWeek)
      .maybeSingle();

    // Compute submission period: opens = week start 00:00 KST, closes = Wednesday 22:00 KST
    // KST = UTC+9, so 00:00 KST = previous day 15:00 UTC, 22:00 KST = 13:00 UTC
    const wednesdayMs = weekStartMs + 2 * DAY_MS;
    const submissionOpensAt = new Date(weekStartMs - 9 * 3600_000).toISOString();
    const submissionClosesAt = new Date(
      wednesdayMs + 22 * 3600_000 - 9 * 3600_000,
    ).toISOString();

    return Response.json({
      success: true,
      data: {
        weekId: weekRow?.id ?? null,
        seasonKey: seasonDbKey(season),
        seasonName: `${season.type} 시즌`,
        year: season.year,
        weekNumber,
        startDate: weekStart,
        endDate: weekEnd,
        isOfficialRest: weekRow?.is_official_rest ?? isOfficialRest,
        canOpen: !isOfficialRest && weekRow?.id != null,
        submissionOpensAt: isOfficialRest ? null : submissionOpensAt,
        submissionClosesAt: isOfficialRest ? null : submissionClosesAt,
      },
    });
  } catch (error) {
    console.error("[admin/cluster4/current-week GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get current week",
      },
      { status: 500 },
    );
  }
}
