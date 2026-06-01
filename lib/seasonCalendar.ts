// Cluster3 시즌 달력 — browser-safe, DB 접근 없음.
//
// 시즌 주수 (seasonWeeks, 고정):
//   겨울 8w · 봄 16w · 여름 8w · 가을 16w
//
// 집계 범위 (seasonWeeks + 전환 주차 1w):
//   겨울 9w · 봄 17w · 여름 9w · 가을 17w  = 52w/year
//
// 전환 주차는 직전 시즌에 귀속된다.
// 공식: 앵커 2023-01-02 (Mon), 연간 364일(52주) 순환.

export type SeasonType = "겨울" | "봄" | "여름" | "가을";

export type Season = {
  year: number;
  type: SeasonType;
  seasonWeeks: number;  // 시즌 자체 주수 (8 또는 16, UI 표시용)
  startDate: string;    // YYYY-MM-DD (Mon)
  endDate: string;      // YYYY-MM-DD (Sun), 전환 주차 포함 — 집계 범위 끝
};

const ANCHOR_MS = Date.UTC(2023, 0, 2); // 2023-01-02 Mon
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const CHAIN: readonly { type: SeasonType; weeks: number }[] = [
  { type: "겨울", weeks: 8 },
  { type: "봄",   weeks: 16 },
  { type: "여름", weeks: 8 },
  { type: "가을", weeks: 16 },
];

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function toMs(iso: string): number {
  return Date.UTC(
    +iso.slice(0, 4),
    +iso.slice(5, 7) - 1,
    +iso.slice(8, 10),
  );
}

export function getSeasonCalendar(year: number): Season[] {
  const yearOffset = year - 2023;
  let cursor = ANCHOR_MS + yearOffset * 364 * DAY_MS;

  return CHAIN.map(({ type, weeks }) => {
    const startMs = cursor;
    const aggregateWeeks = weeks + 1; // seasonWeeks + 전환 주차
    const endMs = startMs + aggregateWeeks * WEEK_MS - DAY_MS;
    cursor = endMs + DAY_MS;
    return {
      year,
      type,
      seasonWeeks: weeks,
      startDate: fmt(startMs),
      endDate: fmt(endMs),
    };
  });
}

export function getSeasonForDate(iso: string): Season | null {
  const ms = toMs(iso);
  const approxYear = new Date(ms).getUTCFullYear();

  for (const y of [approxYear - 1, approxYear, approxYear + 1]) {
    for (const season of getSeasonCalendar(y)) {
      if (ms >= toMs(season.startDate) && ms <= toMs(season.endDate)) {
        return season;
      }
    }
  }
  return null;
}

const SEASON_TYPE_DB: Record<SeasonType, string> = {
  "겨울": "winter",
  "봄": "spring",
  "여름": "summer",
  "가을": "autumn",
};

export type DbSeasonKey = `${number}-${string}`;

export function toDbSeasonKey(year: number, type: SeasonType): DbSeasonKey {
  return `${year}-${SEASON_TYPE_DB[type]}`;
}

export function seasonDbKey(season: Season): DbSeasonKey {
  return toDbSeasonKey(season.year, season.type);
}

// ─────────────────────────────────────────────────────────────────────
// 주간 공식 상태 판별 (DB 무관, 순수 캘린더 규칙)
//
// 봄/가을 (16주 시즌):
//   주 6~8  → official_rest
//   주 9~13 → running
//   주 14~16 → official_rest
//   주 17   → transition (전환 주차, seasonWeeks+1)
//
// 여름/겨울 (8주 시즌):
//   주 1~8  → running (명절은 별도 DB 조회)
//   주 9    → transition
//
// 명절(구정/추석)은 이 함수에서 처리하지 않는다 → DB 조회 레이어에서 보완.
// ──────────────────────────���──────────────────────────────────────────
export type CalendarWeekStatus = "running" | "official_rest" | "transition";

export function getCalendarWeekStatus(
  seasonType: SeasonType,
  weekNumber: number,
  seasonWeeks: number,
): CalendarWeekStatus {
  if (weekNumber > seasonWeeks) return "transition";

  if (seasonType === "봄" || seasonType === "가을") {
    if (weekNumber >= 6 && weekNumber <= 8) return "official_rest";
    if (weekNumber >= 14 && weekNumber <= 16) return "official_rest";
  }

  return "running";
}

// 주차 시작일(월요일) → 시즌 상대 주차 상태(running/official_rest/transition).
// DB 무관, 순수 캘린더 규칙. week_start_date 만으로 판정한다.
export function getSeasonWeekStatusForDate(
  weekStartIso: string,
): CalendarWeekStatus | null {
  const season = getSeasonForDate(weekStartIso);
  if (!season) return null;
  const weekIndex = Math.floor(
    (toMs(weekStartIso) - toMs(season.startDate)) / WEEK_MS,
  );
  if (weekIndex < 0) return null;
  return getCalendarWeekStatus(season.type, weekIndex + 1, season.seasonWeeks);
}

// 전환 주차(시즌 정규 주수 +1) 여부. 전환 주차는 공식 휴식이 아니며,
// 성장/휴식/인정 집계의 분자·분모 모두에서 제외한다.
export function isTransitionWeekStart(weekStartIso: string): boolean {
  return getSeasonWeekStatusForDate(weekStartIso) === "transition";
}

export function getUserSeasons(
  activityStartedAt: string,
  activityEndedAt: string | null,
): Season[] {
  const startMs = toMs(activityStartedAt);
  const endMs = activityEndedAt ? toMs(activityEndedAt) : Date.now();

  const startYear = new Date(startMs).getUTCFullYear();
  const endYear = new Date(endMs).getUTCFullYear();

  const result: Season[] = [];
  for (let y = startYear - 1; y <= endYear + 1; y++) {
    for (const season of getSeasonCalendar(y)) {
      const sMs = toMs(season.startDate);
      const eMs = toMs(season.endDate);
      if (sMs > endMs) continue;
      if (eMs < startMs) continue;
      result.push(season);
    }
  }
  return result;
}
