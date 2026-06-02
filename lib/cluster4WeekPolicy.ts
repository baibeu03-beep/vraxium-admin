// Cluster4 라인 개설 "주차 정책" — browser-safe, DB 접근 없음.
//
// 운영 정책:
//   현재 주차 N = 오늘 날짜가 속한 주차.
//   개설 가능 주차 = N 의 직전 주차 (N-1).
//
//   예) 오늘이 봄 13주차(N)이면 라인 개설 대상은 12주차(N-1).
//
// 일반(운영) 모드에서는 서버가 이 모듈로 N-1 을 직접 계산해 강제한다.
// dev 모드(?dev=true)에서만 과거 주차 선택을 허용한다 (테스트 목적).
//
// 주의: seasonCalendar 만 의존하며 weeks 테이블 lookup 은 하지 않는다.
//       (iso_year / iso_week 키만 산출 → 호출부에서 weeks 행을 조회)

import {
  getSeasonForDate,
  getCalendarWeekStatus,
  seasonDbKey,
  type Season,
} from "@/lib/seasonCalendar";

const DAY_MS = 86_400_000;

// 운영 정책상 개설 가능 주차 오프셋 (현재 주차 N 기준 몇 주 전인지). N-1 → 1.
export const OPENABLE_WEEK_OFFSET = 1;

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

export type Cluster4WeekDescriptor = {
  season: Season;
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  weekStart: string;
  weekEnd: string;
  isoYear: number;
  isoWeek: number;
  isOfficialRest: boolean;
  // 휴식 주차면 null.
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

// 기입(제출) 기간 = "귀속 주차의 다음 주". 라인은 운영상 N-1 주차에 귀속되지만
// 대상자는 그 다음 주(현재 주차 N)에 기입/제출한다. 따라서 기입 기간은 항상
// 귀속 주차 시작일을 기준으로 1주 뒤로 산출한다.
//   기입 시작 = 귀속 주차 시작일 + 7일 (다음 주 월요일) 00:00 KST
//   기입 마감 = 귀속 주차 시작일 + 9일 (다음 주 수요일) 22:00 KST
// KST = UTC+9 → 00:00 KST = −9h UTC, 22:00 KST = +13h UTC.
//
// 4허브(실무 정보/역량/경험/경력) 라인 개설 화면의 모든 기입 기간 표시·저장은
// 이 단일 함수로 계산한다(하드코딩/개별 계산 금지).
export function submissionWindowForWeekStartMs(weekStartMs: number): {
  submissionOpensAt: string;
  submissionClosesAt: string;
} {
  const openMondayMs = weekStartMs + 7 * DAY_MS; // 다음 주 월요일 00:00 KST
  const closeWednesdayMs = weekStartMs + 9 * DAY_MS; // 다음 주 수요일 22:00 KST
  return {
    submissionOpensAt: new Date(openMondayMs - 9 * 3600_000).toISOString(),
    submissionClosesAt: new Date(
      closeWednesdayMs + 22 * 3600_000 - 9 * 3600_000,
    ).toISOString(),
  };
}

// ISO(YYYY-MM-DD) 주차 시작일(월요일) → 기입 기간. 서버 라우트 등 ms 가 없는 호출부용.
export function submissionWindowForWeekStartIso(weekStartIso: string): {
  submissionOpensAt: string;
  submissionClosesAt: string;
} {
  return submissionWindowForWeekStartMs(toMs(weekStartIso));
}

// 주차 시작(월요일) ms → 주차 서술자. 시즌/주차번호/기입기간/iso 키를 산출한다.
export function describeWeekByStartMs(
  weekStartMs: number,
): Cluster4WeekDescriptor | null {
  const weekStart = fmtDate(weekStartMs);
  const season = getSeasonForDate(weekStart);
  if (!season) return null;

  const seasonStartMs = toMs(season.startDate);
  const weekIndex = Math.floor((weekStartMs - seasonStartMs) / (7 * DAY_MS));
  if (weekIndex < 0) return null;
  const weekNumber = weekIndex + 1;
  const weekEnd = fmtDate(weekStartMs + 6 * DAY_MS);

  const status = getCalendarWeekStatus(
    season.type,
    weekNumber,
    season.seasonWeeks,
  );
  const isOfficialRest = status === "official_rest" || status === "transition";

  // 기입 기간 = 귀속 주차의 다음 주(월 00:00 ~ 수 22:00 KST). 공통 함수로 계산.
  const { submissionOpensAt, submissionClosesAt } =
    submissionWindowForWeekStartMs(weekStartMs);

  const { isoYear, isoWeek } = getISOWeekInfo(weekStart);

  return {
    season,
    seasonKey: seasonDbKey(season),
    seasonName: `${season.type} 시즌`,
    year: season.year,
    weekNumber,
    weekStart,
    weekEnd,
    isoYear,
    isoWeek,
    isOfficialRest,
    submissionOpensAt: isOfficialRest ? null : submissionOpensAt,
    submissionClosesAt: isOfficialRest ? null : submissionClosesAt,
  };
}

// 오늘이 속한 주차 N 의 시작(월요일) ms.
export function getCurrentWeekStartMs(todayIso: string): number | null {
  const season = getSeasonForDate(todayIso);
  if (!season) return null;
  const seasonStartMs = toMs(season.startDate);
  const todayMs = toMs(todayIso);
  const weekIndex = Math.floor((todayMs - seasonStartMs) / (7 * DAY_MS));
  return seasonStartMs + weekIndex * 7 * DAY_MS;
}

// 현재 주차 N 기준 offsetWeeksBack 주 전 주차의 시작 ms (offset 0 → N, 1 → N-1 …).
export function getWeekStartMsByOffset(
  todayIso: string,
  offsetWeeksBack: number,
): number | null {
  const cur = getCurrentWeekStartMs(todayIso);
  if (cur == null) return null;
  return cur - offsetWeeksBack * 7 * DAY_MS;
}

// 현재 주차 N 서술자.
export function describeCurrentWeek(
  todayIso: string,
): Cluster4WeekDescriptor | null {
  const ms = getCurrentWeekStartMs(todayIso);
  return ms == null ? null : describeWeekByStartMs(ms);
}

// 개설 가능 주차(N-1) 서술자 — 운영 모드 강제 대상.
export function describeOpenableWeek(
  todayIso: string,
): Cluster4WeekDescriptor | null {
  const ms = getWeekStartMsByOffset(todayIso, OPENABLE_WEEK_OFFSET);
  return ms == null ? null : describeWeekByStartMs(ms);
}
