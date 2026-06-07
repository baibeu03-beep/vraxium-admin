import { randomUUID } from "crypto";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  createOfficialRestPeriod,
  fetchActiveRestPeriods,
} from "@/lib/officialRestPeriodsData";
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
  holiday_name: string | null;
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
  // 사용자 노출용 비고(휴식명/설명) — weeks.holiday_name 그대로. 없으면 null.
  holiday_name: string | null;
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
        "id,season_key,week_number,start_date,end_date,is_official_rest,iso_year,iso_week,holiday_name",
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
        holiday_name: week.holiday_name,
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

// ── 기간 등록 (POST) ─────────────────────────────────────────────────────────
// 기간 정보(GET)와 동일한 원천(weeks/season_definitions/seasons)에 그대로 insert 한다.
// 별도 테이블/전용 DTO 없음 — 등록 직후 GET 에 즉시 조회된다.

const REGISTER_YEARS = [2022, 2023, 2024, 2025, 2026] as const;
const SEASON_TYPES = ["winter", "spring", "summer", "autumn"] as const;
type RegisterSeasonType = (typeof SEASON_TYPES)[number];

const NOTE_MAX_LENGTH = 30;
const WEEK_NUMBER_MIN = 0;
const WEEK_NUMBER_MAX = 18;

type RegisterBody = {
  year?: unknown;
  season_type?: unknown;
  week_number?: unknown;
  is_official_rest?: unknown;
  note?: unknown;
  week_start_date?: unknown;
  week_end_date?: unknown;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ISO 주차 계산 — 라이브 weeks 컨벤션 미러 (week_index=iso_week, B7 apply 와 동일 로직).
function isoWeekOf(dateIso: string): { isoYear: number; isoWeek: number } {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // 그 주의 목요일
  const isoYear = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(
    ((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7,
  );
  return { isoYear, isoWeek };
}

const tsOf = (dateIso: string) => `${dateIso}T00:00:00+00:00`;

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function badRequest(message: string) {
  return Response.json({ success: false, error: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return badRequest("요청 본문(JSON)을 해석할 수 없습니다.");
  }

  // ── 입력 검증 ──
  const year = Number(body.year);
  if (!REGISTER_YEARS.includes(year as (typeof REGISTER_YEARS)[number])) {
    return badRequest("연도는 2022~2026 중에서 선택해야 합니다.");
  }

  const seasonType = body.season_type;
  if (
    typeof seasonType !== "string" ||
    !SEASON_TYPES.includes(seasonType as RegisterSeasonType)
  ) {
    return badRequest("시즌은 겨울/봄/여름/가을 중에서 선택해야 합니다.");
  }

  const weekNumber = Number(body.week_number);
  if (
    !Number.isInteger(weekNumber) ||
    weekNumber < WEEK_NUMBER_MIN ||
    weekNumber > WEEK_NUMBER_MAX
  ) {
    return badRequest("주차는 0~18 사이의 정수여야 합니다.");
  }

  if (typeof body.is_official_rest !== "boolean") {
    return badRequest("활동 구분(공식 활동/공식 휴식)을 선택해야 합니다.");
  }
  const isOfficialRest = body.is_official_rest;

  // 시험기간 고정 휴식(2026-06-07 정책 확정): 봄/가을 6~8·14~16주차는 공식 휴식 고정 —
  // "공식 활동" 등록을 차단한다. (설/추석/기타는 주차가 매년 달라 관리자 휴식 등록으로 처리)
  if (
    !isOfficialRest &&
    calendarOfficialRest(seasonType as RegisterSeasonType, weekNumber) === true
  ) {
    return badRequest("해당 주차는 시험기간 공식 휴식 주차입니다.");
  }

  let note: string | null = null;
  if (body.note != null) {
    if (typeof body.note !== "string") {
      return badRequest("비고는 문자열이어야 합니다.");
    }
    const trimmed = body.note.trim();
    if (trimmed.length > NOTE_MAX_LENGTH) {
      return badRequest(`비고는 최대 ${NOTE_MAX_LENGTH}자까지 입력할 수 있습니다.`);
    }
    note = trimmed.length > 0 ? trimmed : null;
  }

  const startDate = body.week_start_date;
  const endDate = body.week_end_date;
  if (typeof startDate !== "string" || !DATE_RE.test(startDate)) {
    return badRequest("주차 기간(시작일)을 선택해야 합니다.");
  }
  if (typeof endDate !== "string" || !DATE_RE.test(endDate)) {
    return badRequest("주차 기간(종료일)을 선택해야 합니다.");
  }
  if (new Date(`${startDate}T00:00:00Z`).getUTCDay() !== 1) {
    return badRequest("주차 시작일은 월요일이어야 합니다.");
  }
  if (addDaysIso(startDate, 6) !== endDate) {
    return badRequest("주차 종료일은 시작일로부터 6일 뒤 일요일이어야 합니다.");
  }

  const seasonKey = `${year}-${seasonType}`;

  try {
    // ── 시즌 정의 확인 (기간 정보 GET 이 season_definitions 기준으로 조회하므로 필수) ──
    const { data: seasonDef, error: seasonDefError } = await supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .eq("season_key", seasonKey)
      .maybeSingle();

    if (seasonDefError) {
      return Response.json(
        { success: false, error: seasonDefError.message },
        { status: 500 },
      );
    }
    if (!seasonDef) {
      return badRequest(
        `시즌 정의(${seasonKey})가 존재하지 않아 등록할 수 없습니다.`,
      );
    }

    // ── 중복 등록 방지: 동일 연도+시즌+주차 = 동일 season_key+week_number ──
    const { data: dupRows, error: dupError } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("season_key", seasonKey)
      .eq("week_number", weekNumber)
      .limit(1);

    if (dupError) {
      return Response.json(
        { success: false, error: dupError.message },
        { status: 500 },
      );
    }
    if ((dupRows ?? []).length > 0) {
      return Response.json(
        { success: false, error: "동일한 주차 정보를 가진 기간이 있습니다." },
        { status: 409 },
      );
    }

    // ── weeks.season_id NOT NULL — seasons(uuid) find-or-create (B7 컨벤션 미러:
    //    name=season_label 매칭, 신설 시 season_index=max+1, started/ended=정의 날짜 00:00Z) ──
    const seasonLabel = (seasonDef as SeasonDefinitionRow).season_label;
    if (!seasonLabel) {
      return badRequest(
        `시즌 정의(${seasonKey})에 라벨이 없어 등록할 수 없습니다.`,
      );
    }

    const { data: seasonRow, error: seasonRowError } = await supabaseAdmin
      .from("seasons")
      .select("id")
      .eq("name", seasonLabel)
      .maybeSingle();

    if (seasonRowError) {
      return Response.json(
        { success: false, error: seasonRowError.message },
        { status: 500 },
      );
    }

    let seasonId = (seasonRow as { id: string } | null)?.id ?? null;
    if (!seasonId) {
      const def = seasonDef as SeasonDefinitionRow;
      if (!def.start_date || !def.end_date) {
        return badRequest(
          `시즌 정의(${seasonKey})에 기간 정보가 없어 등록할 수 없습니다.`,
        );
      }
      const { data: maxIndexRows, error: maxIndexError } = await supabaseAdmin
        .from("seasons")
        .select("season_index")
        .order("season_index", { ascending: false })
        .limit(1);
      if (maxIndexError) {
        return Response.json(
          { success: false, error: maxIndexError.message },
          { status: 500 },
        );
      }
      const nextIndex =
        ((maxIndexRows?.[0] as { season_index: number | null } | undefined)
          ?.season_index ?? 0) + 1;

      const newSeasonId = randomUUID();
      const { error: seasonInsertError } = await supabaseAdmin
        .from("seasons")
        .insert({
          id: newSeasonId,
          season_index: nextIndex,
          name: seasonLabel,
          started_at: tsOf(def.start_date),
          ended_at: tsOf(def.end_date),
        });
      if (seasonInsertError) {
        return Response.json(
          { success: false, error: seasonInsertError.message },
          { status: 500 },
        );
      }
      seasonId = newSeasonId;
    }

    // ── weeks insert (라이브 컨벤션: week_index=iso_week, started/ended=date 00:00Z,
    //    check_threshold 미설정=read-time 기본, result_published_at 없음=publish 별도 경로) ──
    const { isoYear, isoWeek } = isoWeekOf(startDate);
    const weekId = randomUUID();
    const { error: weekInsertError } = await supabaseAdmin.from("weeks").insert({
      id: weekId,
      season_id: seasonId,
      season_key: seasonKey,
      week_number: weekNumber,
      week_index: isoWeek,
      start_date: startDate,
      end_date: endDate,
      started_at: tsOf(startDate),
      ended_at: tsOf(endDate),
      iso_year: isoYear,
      iso_week: isoWeek,
      is_official_rest: isOfficialRest,
      holiday_name: note,
    });

    if (weekInsertError) {
      return Response.json(
        { success: false, error: weekInsertError.message },
        { status: 500 },
      );
    }

    // ── 공식 휴식 등록 → 신규 판정 SoT(official_rest_periods) 동기화 ──
    // 최종 휴식 판정 = season_rule ∨ date_period (weeks.is_official_rest 는 legacy 표시 전용,
    // 2026-05-31 확정 정책). season_rule(시험기간)이 이미 휴식인 주차는 period 불필요.
    // 실패 시 weeks insert 를 되돌려 부분 등록 상태를 남기지 않는다.
    let restPeriodId: string | null = null;
    const seasonRuleRest =
      calendarOfficialRest(
        (seasonDef as SeasonDefinitionRow).season_type,
        weekNumber,
      ) === true;
    if (isOfficialRest && !seasonRuleRest) {
      try {
        const period = await createOfficialRestPeriod({
          name: note ?? `${seasonLabel} ${weekNumber}주차 공식 휴식`,
          type: "temporary",
          startDate,
          endDate,
          description: "기간 등록 화면에서 등록된 공식 휴식",
          isActive: true,
        });
        restPeriodId = period.id;
      } catch (error) {
        await supabaseAdmin.from("weeks").delete().eq("id", weekId);
        return Response.json(
          {
            success: false,
            error:
              error instanceof Error
                ? `공식 휴식 기간 등록 실패: ${error.message}`
                : "공식 휴식 기간 등록에 실패했습니다.",
          },
          { status: 500 },
        );
      }
    }

    return Response.json({
      success: true,
      data: {
        week_id: weekId,
        season_key: seasonKey,
        week_number: weekNumber,
        week_start_date: startDate,
        week_end_date: endDate,
        is_official_rest: isOfficialRest,
        holiday_name: note,
        rest_period_id: restPeriodId,
      },
    });
  } catch (error) {
    console.error("[admin/season-weeks POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to register season week",
      },
      { status: 500 },
    );
  }
}
