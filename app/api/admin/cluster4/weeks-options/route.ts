import { NextRequest } from "next/server";
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

// 라인 개설 어드민 UI 에서 사용하는 "최근 주차 옵션" 엔드포인트.
// 현재 주차 N 을 포함해 직전 몇 주(N-1, N-2 ...) 까지 weeks 테이블에서 매칭한 행만 돌려준다.
// 운영 기본 정책상 라인은 N 에만 개설하지만, 어드민/테스트 검증을 위해 N-1 선택을 허용해야 한다.

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 6;

function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
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

type WeekOption = {
  // Canonical fields — UI 와 POST body 사이 혼동을 막기 위해 단일 키로 노출.
  id: string;             // weeks.id (UUID) — POST body 의 week_id 로 그대로 전달.
  label: string;          // "{year}년도 {season} {weekNumber}w" 형태의 표시용 라벨.
  weekId: string;         // legacy alias = id (이전 코드 호환).
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  isCurrent: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

function buildWeekDescriptor(weekStartMs: number) {
  const weekStart = fmtDate(weekStartMs);
  const weekEndMs = weekStartMs + 6 * DAY_MS;
  const weekEnd = fmtDate(weekEndMs);

  const season = getSeasonForDate(weekStart);
  if (!season) return null;

  const seasonStartMs = toMs(season.startDate);
  const weekIndex = Math.floor((weekStartMs - seasonStartMs) / (7 * DAY_MS));
  if (weekIndex < 0) return null;
  const weekNumber = weekIndex + 1;

  const calendarStatus = getCalendarWeekStatus(
    season.type,
    weekNumber,
    season.seasonWeeks,
  );
  const isOfficialRest =
    calendarStatus === "official_rest" || calendarStatus === "transition";

  // KST = UTC+9 → 00:00 KST = -9h UTC from week start, Wed 22:00 KST = +13h UTC.
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  const submissionOpensAt = new Date(weekStartMs - 9 * 3600_000).toISOString();
  const submissionClosesAt = new Date(
    wednesdayMs + 22 * 3600_000 - 9 * 3600_000,
  ).toISOString();

  const { isoYear, isoWeek } = getISOWeekInfo(weekStart);

  return {
    season,
    seasonName: `${season.type} 시즌`,
    weekNumber,
    weekStart,
    weekEnd,
    isOfficialRest,
    submissionOpensAt,
    submissionClosesAt,
    isoYear,
    isoWeek,
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

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
    }
  }

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const todaySeason = getSeasonForDate(todayIso);
    if (!todaySeason) {
      return Response.json(
        { success: false, error: "현재 시즌을 찾을 수 없습니다" },
        { status: 500 },
      );
    }

    const seasonStartMs = toMs(todaySeason.startDate);
    const todayMs = toMs(todayIso);
    const currentWeekIndex = Math.floor(
      (todayMs - seasonStartMs) / (7 * DAY_MS),
    );
    const currentWeekStartMs = seasonStartMs + currentWeekIndex * 7 * DAY_MS;

    const descriptors: Array<{
      isCurrent: boolean;
      info: ReturnType<typeof buildWeekDescriptor>;
    }> = [];
    for (let offset = 0; offset < limit; offset++) {
      const weekStartMs = currentWeekStartMs - offset * 7 * DAY_MS;
      const info = buildWeekDescriptor(weekStartMs);
      if (!info) continue;
      descriptors.push({ isCurrent: offset === 0, info });
    }

    if (descriptors.length === 0) {
      return Response.json({ success: true, data: { weeks: [] } });
    }

    // weeks 테이블 lookup — 매칭되는 행이 없으면 라인 개설 불가 처리.
    const isoPairs = descriptors
      .map((d) => d.info)
      .filter((info): info is NonNullable<typeof info> => Boolean(info));

    // Supabase JS 의 in-filter 만으로 (iso_year, iso_week) 페어 조회가 불편하므로 OR 표현식 사용.
    const orExpr = isoPairs
      .map((p) => `and(iso_year.eq.${p.isoYear},iso_week.eq.${p.isoWeek})`)
      .join(",");

    const { data: weekRows, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id,iso_year,iso_week,start_date,end_date,is_official_rest")
      .or(orExpr);

    if (weekError) {
      return Response.json(
        { success: false, error: weekError.message },
        { status: 500 },
      );
    }

    type WeekRow = {
      id: string;
      iso_year: number;
      iso_week: number;
      start_date: string;
      end_date: string;
      is_official_rest: boolean | null;
    };

    const weekRowByKey = new Map<string, WeekRow>();
    for (const row of (weekRows ?? []) as WeekRow[]) {
      weekRowByKey.set(`${row.iso_year}::${row.iso_week}`, row);
    }

    const weeks: WeekOption[] = [];
    for (const { isCurrent, info } of descriptors) {
      if (!info) continue;
      const row = weekRowByKey.get(`${info.isoYear}::${info.isoWeek}`);
      if (!row) continue;

      const isOfficialRest = row.is_official_rest ?? info.isOfficialRest;
      const canOpen = !isOfficialRest;
      const label = `${info.season.year}년도 ${info.seasonName} ${info.weekNumber}w`;
      weeks.push({
        id: row.id,
        label,
        weekId: row.id, // legacy alias
        seasonKey: seasonDbKey(info.season),
        seasonName: info.seasonName,
        year: info.season.year,
        weekNumber: info.weekNumber,
        startDate: info.weekStart,
        endDate: info.weekEnd,
        isOfficialRest,
        canOpen,
        isCurrent,
        submissionOpensAt: isOfficialRest ? null : info.submissionOpensAt,
        submissionClosesAt: isOfficialRest ? null : info.submissionClosesAt,
      });
    }

    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    console.error("[admin/cluster4/weeks-options GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load weeks options",
      },
      { status: 500 },
    );
  }
}
