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

// 전환 주차 사용자/관리자 공통 표시명. 숫자 주차(0주차/17주차 등) 대신 이 라벨을 쓴다.
export const TRANSITION_WEEK_LABEL = "전환 주차";

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

// ─────────────────────────────────────────────────────────────────────
// 시즌/주차 "현재 기준 시각" — 매주 월요일 00:01 KST 경계 (2026-06-29 변경).
//
// 배경: 내부 캘린더는 UTC 자정 앵커(ANCHOR_MS = Date.UTC(2023,0,2))를 쓰므로, 추상 주차
//   시작(월요일 00:00 UTC)은 실제로 "월요일 09:00 KST"에 해당한다. 종전에는 "현재 날짜"를
//   UTC 날짜(new Date().toISOString().slice(0,10))로 뽑아 현재 시즌/주차 선택과 snapshot
//   경계가 모두 월요일 09:00 KST 에 넘어갔다.
//
// 변경: 경계를 매주 월요일 00:01 KST 로 통일한다. 두 축을 함께 옮긴다.
//   ① 현재 시즌/주차 선택 → getCurrentActivityDateIso(): KST(UTC+9) 기준 날짜를 쓰되,
//      00:01 에 날짜가 넘어가도록 1분을 보정한다(= +9h − 1min 시프트 후 날짜 절단). 따라서
//      날짜 문자열이 "월요일 00:01 KST"에 다음 주로 넘어간다. 현재-시각 기반 시즌/주차 계산
//      (운영자/고객/데모/일반)은 전부 이 단일 함수를 입력으로 쓴다(인라인 UTC/KST 시프트 금지).
//   ② snapshot 신선도 경계 → weekStartToBoundaryMs(): 추상 주차 시작(월요일 00:00 UTC)을
//      실제 경계 시각(월요일 00:01 KST = 00:00 UTC − 9h + 1min)으로 변환한다. snapshot
//      .computed_at < 이 값이면 주차 경계를 지난 것(boundary-stale). ①과 동일하게 00:01 KST.
//
//   ⚠ getCurrentWeekStartMs/describeWeekByStartMs 가 반환하는 추상 주차 시작(월요일 00:00
//      UTC)의 의미는 바꾸지 않는다 — week_start_date 등 날짜 마커로 쓰이기 때문. 본 변경은
//      "현재 시각 → 어느 날짜/주차인가" 입력과 "신선도 경계 시각"만 옮긴다.
// ─────────────────────────────────────────────────────────────────────
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 주차/시즌 경계 = 매주 월요일 00:01 KST (자정 직후 1분). 단일 상수 — 경계 시각 변경은 여기 한 곳.
export const WEEK_BOUNDARY_KST_MS = 1 * 60 * 1000;

// 현재 시각 기준 "활동 날짜"(YYYY-MM-DD) — 매일 00:01 KST 에 날짜가 넘어간다(주차 경계는
//   월요일 00:01 KST). 현재 시즌/주차/개설대상 주차 선택의 단일 입력. UTC 날짜
//   (new Date().toISOString())나 인라인 KST 시프트를 직접 쓰지 말고 항상 이 함수를 쓴다
//   (운영자/고객/데모/일반 일관 — 같은 시각이면 모두 같은 날짜/주차).
export function getCurrentActivityDateIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + KST_OFFSET_MS - WEEK_BOUNDARY_KST_MS)
    .toISOString()
    .slice(0, 10);
}

// 추상 주차 시작(월요일 00:00 UTC ms) → 실제 주차 경계 시각 ms(월요일 00:01 KST).
//   snapshot.computed_at(타임스탬프)와 비교해 boundary-stale 을 판정한다. ①과 같은 경계 시각.
export function weekStartToBoundaryMs(weekStartMs: number): number {
  return weekStartMs - KST_OFFSET_MS + WEEK_BOUNDARY_KST_MS;
}

// 주어진 주차(week_start_date = 월요일 "YYYY-MM-DD")가 현재 시각 기준 이미 "시작"됐는가.
//   경계 = 그 주 월요일 00:01 KST(weekStartToBoundaryMs). **실제 타임스탬프(절대 ms) 비교** —
//   문자열/주차번호 비교가 아니라 now(ms) >= 그 주 경계(ms). 절대 시각 비교라 서버/화면·TZ 무관.
//   긴급 휴식 상태 판정(이행/승인)의 단일 SoT: 시작 이후(같음 포함)=이행, 이전=승인.
//     const started = nowMs >= weekStartToBoundaryMs(weekStartMs);  // KST 00:01 경계
export function hasWeekStartedKst(
  weekStartDateIso: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!weekStartDateIso) return false;
  const weekStartMs = Date.UTC(
    +weekStartDateIso.slice(0, 4),
    +weekStartDateIso.slice(5, 7) - 1,
    +weekStartDateIso.slice(8, 10),
  );
  if (Number.isNaN(weekStartMs)) return false;
  return nowMs >= weekStartToBoundaryMs(weekStartMs);
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

// 한글 시즌 타입 → 영문 코드 ("봄"→"spring"). seasonSummary.seasonCode source.
export function seasonTypeToCode(type: SeasonType): string {
  return SEASON_TYPE_DB[type];
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
//
// ⚠ 이 함수는 순수 캘린더(날짜)만 본다 — 시즌 "귀속"(prev/next)과 무관하게 전환 주차의
//   월요일이면 true. 내부 계산은 직전 시즌 기준 인덱싱(주 seasonWeeks+1)으로 전환을
//   "판별"하지만, 전환 주차의 **DB/운영 귀속은 다음 시즌 0주차**이다([[isTransitionWeek]],
//   getOperationalSeason). 즉 "언제가 전환인가"(날짜) 와 "어느 시즌 소속인가"(다음 시즌)는
//   분리된 개념이며, 이 함수는 전자만 답한다.
export function isTransitionWeekStart(weekStartIso: string): boolean {
  return getSeasonWeekStatusForDate(weekStartIso) === "transition";
}

// ── 전환 주차 공통 판정 (단일 SoT) ───────────────────────────────────────────
// 전환 주차 = 시즌 사이 1주 브릿지. DB 저장 규칙: season_key/season_id = **다음 시즌**,
//   week_number = **0**. season_definitions 의 공식 시즌 경계(1주차 시작)는 유지되고,
//   전환 주차는 그 사이 gap 에 위치한다.
//
// 판정 우선순위(하나라도 참이면 전환):
//   1) 날짜 기준 — week_start_date 가 전환 주차 월요일(isTransitionWeekStart). 순수 캘린더 SoT.
//   2) DB 귀속 기준 — week_number === 0. 재귀속된 weeks/uws 행의 표식.
// week_number 값만 단독으로(예: > seasonWeeks) 쓰거나 비고 문자열로 판정하지 말고 이 함수를
//   snapshot·line-opening·process-check·누적 주차·표시 로직 전부에서 공용으로 쓴다.
export function isTransitionWeek(week: {
  week_number?: number | null;
  start_date?: string | null;
  week_start_date?: string | null;
}): boolean {
  const start = week.start_date ?? week.week_start_date ?? null;
  if (start && isTransitionWeekStart(start)) return true;
  if (week.week_number === 0) return true;
  return false;
}

// 이전 시즌(시즌 체인 역방향). 겨울 → 직전 해 가을. (DB 무관·순수 캘린더)
//   전환 주차의 season_key(=다음 시즌)로부터 "출발 시즌"(from)을 복원할 때 쓴다 —
//   예: 재귀속된 2026-summer W0(전환)의 from = 2026-spring. 코드 문자열에서 역추론하지 말 것.
export function getPrevSeason(season: Season): Season {
  const cal = getSeasonCalendar(season.year);
  const idx = cal.findIndex((s) => s.type === season.type);
  if (idx > 0) return cal[idx - 1];
  return getSeasonCalendar(season.year - 1)[CHAIN.length - 1];
}

// ── 주차 표시 라벨 (어드민 vs 크루 formatter 분리, 공통 DTO) ─────────────────
// 데이터(seasonKey/seasonId/weekNumber=0)와 전환 판정(isTransitionWeek)은 어드민·크루 **동일**.
//   표시 문자열만 화면 컨텍스트에 따라 다르게: 어드민 = 실제 값 그대로(0주차 노출),
//   크루/사용자 = 전환 주차면 "전환 주차"(0주차 등 숫자 노출 금지). DTO 를 분기하지 않는다.
const SEASON_KEY_KO_LABEL: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};

export type WeekLabelInput = {
  seasonKey?: string | null;
  isoYear?: number | null;
  weekNumber?: number | null;
  startDate?: string | null;
  weekStartDate?: string | null;
};

function koSeasonFromKey(seasonKey?: string | null): string | null {
  if (!seasonKey) return null;
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_KO_LABEL[part];
    if (ko) return ko;
  }
  return null;
}

function yearFromWeekLabelInput(w: WeekLabelInput): number | null {
  if (typeof w.isoYear === "number") return w.isoYear;
  const m = w.seasonKey?.match(/(20\d{2})/);
  if (m) return Number(m[1]);
  const start = w.startDate ?? w.weekStartDate;
  return start ? Number(start.slice(0, 4)) : null;
}

// 어드민 표시: 실제 DB 값 그대로 — "2026년 여름 시즌 0주차". 전환 주차도 숫자(0)를 노출한다.
//   전환 여부는 활동/상태(isTransitionWeek 기반 "전환 주차" 배지 등)로 구분해 오해를 막는다.
export function formatAdminWeekLabel(w: WeekLabelInput): string {
  const ko = koSeasonFromKey(w.seasonKey);
  const year = yearFromWeekLabelInput(w);
  if (year == null || !ko || w.weekNumber == null) return "-";
  return `${year}년 ${ko} 시즌 ${w.weekNumber}주차`;
}

// 크루/사용자 표시: 전환 주차면 "전환 주차"(0주차·"여름 시즌 0주차" 등 숫자 표기 금지),
//   그 외는 일반 라벨. 어드민과 **동일한** isTransitionWeek() 로 판정한다(데이터/판정 동일·표시만 상이).
export function formatCrewWeekLabel(w: WeekLabelInput): string {
  if (
    isTransitionWeek({
      week_number: w.weekNumber,
      start_date: w.startDate ?? w.weekStartDate,
    })
  ) {
    return TRANSITION_WEEK_LABEL;
  }
  return formatAdminWeekLabel(w);
}

// 시즌 체인상 다음 시즌. 가을(연중 마지막) → 다음 해 겨울. (DB 무관·순수 캘린더)
export function getNextSeason(season: Season): Season {
  const cal = getSeasonCalendar(season.year);
  const idx = cal.findIndex((s) => s.type === season.type);
  if (idx >= 0 && idx < cal.length - 1) return cal[idx + 1];
  return getSeasonCalendar(season.year + 1)[0];
}

// 운영 기준 시즌(operationalSeason): 현재 날짜가 전환 주차(시즌 정규 주수 +1)에 있으면
//   "다음 시즌", 일반 활동 주차이면 "현재 시즌". 회원 명부/현재 활동 회원 목록처럼
//   "지금 운영상 어느 시즌으로 봐야 하는가"가 필요한 화면에서 사용한다.
//   (예: 봄 전환 주차면 여름, 여름 전환 주차면 가을 — 시즌명 하드코딩 없이 캘린더로 산출.)
export function getOperationalSeason(iso: string): Season | null {
  const season = getSeasonForDate(iso);
  if (!season) return null;
  return getSeasonWeekStatusForDate(iso) === "transition"
    ? getNextSeason(season)
    : season;
}

export function operationalSeasonDbKey(iso: string): DbSeasonKey | null {
  const s = getOperationalSeason(iso);
  return s ? seasonDbKey(s) : null;
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
