import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getCurrentActivityDateIso,
  getSeasonForDate,
  getCalendarWeekStatus,
} from "@/lib/seasonCalendar";

const DAY_MS = 86_400_000;

function resolveCurrentWeek(): {
  weekId: string | null;
  weekNumber: number;
  isoYear: number;
  isoWeek: number;
  weekStart: string;
  weekEnd: string;
  isOfficialRest: boolean;
  submissionOpensAt: string;
  submissionClosesAt: string;
} | null {
  const todayIso = getCurrentActivityDateIso();
  const season = getSeasonForDate(todayIso);
  if (!season) return null;

  const seasonStartMs = Date.UTC(
    +season.startDate.slice(0, 4),
    +season.startDate.slice(5, 7) - 1,
    +season.startDate.slice(8, 10),
  );
  const dateMs = Date.UTC(
    +todayIso.slice(0, 4),
    +todayIso.slice(5, 7) - 1,
    +todayIso.slice(8, 10),
  );
  const weekIndex = Math.floor((dateMs - seasonStartMs) / (7 * DAY_MS));
  const weekNumber = weekIndex + 1;
  const weekStartMs = seasonStartMs + weekIndex * 7 * DAY_MS;
  const weekEndMs = weekStartMs + 6 * DAY_MS;

  const calendarStatus = getCalendarWeekStatus(season.type, weekNumber, season.seasonWeeks);
  const isOfficialRest = calendarStatus === "official_rest" || calendarStatus === "transition";

  const d = new Date(`${new Date(weekStartMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);

  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  const submissionOpensAt = new Date(weekStartMs - 9 * 3600_000).toISOString();
  const submissionClosesAt = new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString();

  return {
    weekId: null,
    weekNumber,
    isoYear,
    isoWeek,
    weekStart: new Date(weekStartMs).toISOString().slice(0, 10),
    weekEnd: new Date(weekEndMs).toISOString().slice(0, 10),
    isOfficialRest,
    submissionOpensAt,
    submissionClosesAt,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const { searchParams } = new URL(request.url);
    const organization = searchParams.get("organization");

    let query = supabaseAdmin
      .from("career_projects")
      .select(
        "id,line_code,line_name,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img,default_main_title,default_output_link_1,default_output_link_2,default_output_images,default_target_user_ids,start_date,end_date,organization_slug",
      )
      .not("line_code", "is", null)
      .order("line_code", { ascending: true });

    if (organization) {
      query = query.eq("organization_slug", organization);
    }

    const { data, error } = await query;
    if (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    type Row = {
      id: string;
      line_code: string;
      line_name: string | null;
      company_name: string | null;
      company_logo_url: string | null;
      supervisor_name: string | null;
      supervisor_department: string | null;
      supervisor_position: string | null;
      supervisor_profile_img: string | null;
      default_main_title: string | null;
      default_output_link_1: string | null;
      default_output_link_2: string | null;
      default_output_images: unknown;
      default_target_user_ids: unknown;
      start_date: string | null;
      end_date: string | null;
      organization_slug: string;
    };

    const toArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

    const options = ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      lineCode: r.line_code,
      lineName: r.line_name,
      // 기업명 SoT = career_projects.company_name (supervisor_company 아님).
      companyName: r.company_name,
      // companyLogoUrl 는 업로드된 이미지 URL (career_projects.company_logo_url).
      companyLogoUrl: r.company_logo_url,
      // sponsor-card 감독자 메타 6필드 — weekly-cards DTO 와 동일 source 로 라인 개설 옵션에도 노출.
      supervisorName: r.supervisor_name,
      supervisorDepartment: r.supervisor_department,
      supervisorPosition: r.supervisor_position,
      supervisorPhotoUrl: r.supervisor_profile_img,
      defaultMainTitle: r.default_main_title,
      defaultOutputLink1: r.default_output_link_1,
      defaultOutputLink2: r.default_output_link_2,
      defaultOutputImages: toArr(r.default_output_images),
      defaultTargetUserIds: toArr(r.default_target_user_ids),
      startDate: r.start_date,
      endDate: r.end_date,
    }));

    const week = resolveCurrentWeek();
    let currentWeek: Record<string, unknown> | null = null;

    if (week && !week.isOfficialRest) {
      const { data: weekRow, error: weekError } = await supabaseAdmin
        .from("weeks")
        .select("id")
        .eq("iso_year", week.isoYear)
        .eq("iso_week", week.isoWeek)
        .maybeSingle();

      if (!weekError && weekRow) {
        currentWeek = {
          weekId: weekRow.id,
          weekNumber: week.weekNumber,
          weekStart: week.weekStart,
          weekEnd: week.weekEnd,
          submissionOpensAt: week.submissionOpensAt,
          submissionClosesAt: week.submissionClosesAt,
        };
      }
    }

    return Response.json({
      success: true,
      data: { options, currentWeek },
    });
  } catch (error) {
    console.error("[career-line-options GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 },
    );
  }
}
