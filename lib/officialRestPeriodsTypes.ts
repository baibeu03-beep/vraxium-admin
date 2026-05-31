// Browser-safe constants, types, and pure helpers for 공식 휴식(official rest).
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.
//
// canonical 테이블: public.official_rest_periods
//   (db/migrations/2026-05-31_official_rest_periods.sql)
//
// 정책 (2026-05-31 확정):
//   최종 공식 휴식 = seasonCalendar rule(시험기간 자동계산)
//                  OR official_rest_periods 날짜 overlap(설/추석/임시, 운영자 등록)
//   weeks.is_official_rest / official_rest_weeks 는 legacy — 판정 SoT 아님(표시만).

export type OfficialRestPeriodType =
  | "lunar_new_year"
  | "chuseok"
  | "temporary"
  | "other";

export const OFFICIAL_REST_PERIOD_TYPES: readonly OfficialRestPeriodType[] = [
  "lunar_new_year",
  "chuseok",
  "temporary",
  "other",
] as const;

export const OFFICIAL_REST_PERIOD_TYPE_LABELS: Record<
  OfficialRestPeriodType,
  string
> = {
  lunar_new_year: "설 연휴",
  chuseok: "추석 연휴",
  temporary: "임시 휴식",
  other: "기타",
};

export type OfficialRestPeriodDto = {
  id: string;
  name: string;
  type: OfficialRestPeriodType;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

// 공식 휴식 판정의 출처. 한 주차가 동시에 여러 출처에 걸릴 수 있다.
//   season_rule     — seasonCalendar 규칙(봄/가을 6~8·14~16주차). 자동 계산.
//   date_period     — official_rest_periods 날짜 범위 overlap. 운영자 등록(신규 SoT).
//   legacy_iso_week — official_rest_weeks / weeks.is_official_rest. 표시 전용, 판정 제외.
export type OfficialRestSource = "season_rule" | "date_period" | "legacy_iso_week";

// ─────────────────────────────────────────────────────────────────────
// 날짜 overlap 판정 (요구사항 2)
//   period [start, end] 와 week [start, end] 가 겹치면 true. 양끝 포함(폐구간).
//   date 타입은 YYYY-MM-DD 사전식 비교가 안전하다.
//
//   overlap ⇔ period.start <= week.end AND period.end >= week.start
//
//   다중 주차 겹침(옵션 A): 연휴가 2개 주차에 걸치면 둘 다 overlap=true → 둘 다 휴식.
// ─────────────────────────────────────────────────────────────────────
export type DateRange = { startDate: string; endDate: string };

export function periodOverlapsWeek(period: DateRange, week: DateRange): boolean {
  return period.startDate <= week.endDate && period.endDate >= week.startDate;
}

// 주어진 주차에 겹치는 활성 period 들만 반환. isActive=false 는 제외.
export function matchOfficialRestPeriods(
  week: DateRange,
  periods: readonly OfficialRestPeriodDto[],
): OfficialRestPeriodDto[] {
  return periods.filter(
    (p) => p.isActive && periodOverlapsWeek(p, week),
  );
}

// ─────────────────────────────────────────────────────────────────────
// 최종 공식 휴식 판정 (요구사항 3)
//   isOfficialRest = seasonRuleRest OR (matchedDatePeriods.length > 0)
//   legacyRest 는 sources 에만 노출하고 최종 boolean 에는 반영하지 않는다.
// ─────────────────────────────────────────────────────────────────────
export function resolveOfficialRest(input: {
  seasonRuleRest: boolean;
  matchedDatePeriods: number;
  legacyRest?: boolean;
}): { isOfficialRest: boolean; sources: OfficialRestSource[] } {
  const sources: OfficialRestSource[] = [];
  if (input.seasonRuleRest) sources.push("season_rule");
  if (input.matchedDatePeriods > 0) sources.push("date_period");
  if (input.legacyRest) sources.push("legacy_iso_week");
  return {
    isOfficialRest: input.seasonRuleRest || input.matchedDatePeriods > 0,
    sources,
  };
}

// period.type → 휴식 사유. 기존 mapHolidayReason(문자열 ILIKE) 의 결정적 대체.
// (반환 union 은 cluster4WeeklyGrowthTypes.RestReason 에 할당 가능.)
export function periodTypeToRestReason(
  type: OfficialRestPeriodType | undefined,
): "lunar_new_year" | "chuseok" | null {
  if (type === "lunar_new_year") return "lunar_new_year";
  if (type === "chuseok") return "chuseok";
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// HTTP body(snake_case JSON) → upsert 입력 정규화 + 검증.
//   POST(create) — name/type/start_date/end_date 필수.
//   PATCH(update) — { partial: true } 로 일부 필드만 허용(미지정 필드는 미변경).
//   write 게이트는 API 라우트가 책임(여기선 형식 검증만).
// ─────────────────────────────────────────────────────────────────────
export const OFFICIAL_REST_PERIODS_WRITE_ROLES = ["owner"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OfficialRestPeriodUpsertInput = {
  name: string;
  type: OfficialRestPeriodType;
  startDate: string;
  endDate: string;
  description: string | null;
  isActive: boolean;
};

export type ParseUpsertBodyResult =
  | { ok: true; value: Partial<OfficialRestPeriodUpsertInput> }
  | { ok: false; status: number; error: string };

function isOfficialRestPeriodType(v: unknown): v is OfficialRestPeriodType {
  return (
    typeof v === "string" &&
    (OFFICIAL_REST_PERIOD_TYPES as readonly string[]).includes(v)
  );
}

export function parseOfficialRestPeriodUpsertBody(
  body: unknown,
  opts: { partial?: boolean } = {},
): ParseUpsertBodyResult {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const partial = opts.partial === true;
  const out: Partial<OfficialRestPeriodUpsertInput> = {};
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  // name
  if (has("name")) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      return { ok: false, status: 400, error: "name must be a non-empty string" };
    }
    out.name = input.name.trim();
  } else if (!partial) {
    return { ok: false, status: 400, error: "name is required" };
  }

  // type
  if (has("type")) {
    if (!isOfficialRestPeriodType(input.type)) {
      return {
        ok: false,
        status: 400,
        error: `type must be one of ${OFFICIAL_REST_PERIOD_TYPES.join(", ")}`,
      };
    }
    out.type = input.type;
  } else if (!partial) {
    return { ok: false, status: 400, error: "type is required" };
  }

  // start_date / end_date
  if (has("start_date")) {
    if (typeof input.start_date !== "string" || !DATE_RE.test(input.start_date)) {
      return { ok: false, status: 400, error: "start_date must be YYYY-MM-DD" };
    }
    out.startDate = input.start_date;
  } else if (!partial) {
    return { ok: false, status: 400, error: "start_date is required" };
  }

  if (has("end_date")) {
    if (typeof input.end_date !== "string" || !DATE_RE.test(input.end_date)) {
      return { ok: false, status: 400, error: "end_date must be YYYY-MM-DD" };
    }
    out.endDate = input.end_date;
  } else if (!partial) {
    return { ok: false, status: 400, error: "end_date is required" };
  }

  // end_date >= start_date — 양쪽 값이 모두 알려진 경우에만 검증 가능.
  // (PATCH 로 한쪽만 갱신할 때는 DB CHECK 제약이 최종 방어선)
  if (out.startDate != null && out.endDate != null && out.endDate < out.startDate) {
    return {
      ok: false,
      status: 400,
      error: "end_date must be on or after start_date",
    };
  }

  // description (nullable)
  if (has("description")) {
    if (input.description === null) {
      out.description = null;
    } else if (typeof input.description === "string") {
      const trimmed = input.description.trim();
      out.description = trimmed.length ? trimmed : null;
    } else {
      return { ok: false, status: 400, error: "description must be a string or null" };
    }
  }

  // is_active
  if (has("is_active")) {
    if (typeof input.is_active !== "boolean") {
      return { ok: false, status: 400, error: "is_active must be a boolean" };
    }
    out.isActive = input.is_active;
  }

  if (partial && Object.keys(out).length === 0) {
    return { ok: false, status: 400, error: "No updatable fields provided" };
  }

  return { ok: true, value: out };
}
