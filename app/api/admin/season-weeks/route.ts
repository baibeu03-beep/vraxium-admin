import { randomUUID } from "crypto";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createOfficialRestPeriod } from "@/lib/officialRestPeriodsData";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  start_date: string | null;
  end_date: string | null;
};

const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

// 시험기간 고정 휴식 판정(POST 검증 전용 — GET 의 데이터 구성은 loadSeasonWeeks 가 담당).
function calendarOfficialRest(
  seasonType: string | null,
  weekNumber: number | null,
): boolean | null {
  if (!seasonType || weekNumber == null) return null;

  const seasonWeeks = SEASON_WEEKS[seasonType];
  if (seasonWeeks == null) return null;

  if (weekNumber > seasonWeeks) return false;

  if (seasonType === "spring" || seasonType === "autumn") {
    if (weekNumber >= 6 && weekNumber <= 8) return true;
    if (weekNumber >= 14 && weekNumber <= 16) return true;
  }

  return false;
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
    // 데이터 구성은 lib/adminSeasonWeeksData.loadSeasonWeeks 단일 SoT — 검증 스크립트와 공유.
    const { seasons, rows, conflicts } = await loadSeasonWeeks();
    return Response.json({
      success: true,
      data: {
        seasons,
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
  // 전환 주차 의도(선택). 저장 컬럼 없음 — is_transition 은 week_number(정규 주수 +1)로
  // GET 에서 파생된다. 본 필드는 교차검증 전용이며 미전송(undefined)이면 기존 흐름과 동일.
  is_transition?: unknown;
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

  // 전환 주차(선택): 저장 표현은 공식 활동과 동일(is_official_rest=false)이며 별도 컬럼이 없다.
  //   전환 여부는 GET 에서 week_number(정규 주수 +1)로 파생되므로, 여기서는 의도와 주차 번호가
  //   어긋나는 등록(전환인데 휴식·전환 번호가 아님)을 차단해 조회 시 전환으로 잡히도록 보장한다.
  let isTransition = false;
  if (body.is_transition != null) {
    if (typeof body.is_transition !== "boolean") {
      return badRequest("전환 주차 여부는 true/false 여야 합니다.");
    }
    isTransition = body.is_transition;
  }
  if (isTransition) {
    if (isOfficialRest) {
      return badRequest("전환 주차는 공식 휴식으로 등록할 수 없습니다.");
    }
    const regularWeeks = SEASON_WEEKS[seasonType as RegisterSeasonType];
    if (regularWeeks == null) {
      return badRequest("시즌 정규 주수를 확인할 수 없습니다.");
    }
    if (weekNumber !== regularWeeks + 1) {
      return badRequest(`전환 주차는 ${regularWeeks + 1}주차여야 합니다.`);
    }
  }

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
        // 파생 표시값 — GET 의 is_transition 과 동일 기준(week_number > 정규 주수).
        is_transition: isTransition,
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
