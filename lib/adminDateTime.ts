// 어드민 운영/메타 타임스탬프 표시 공통 유틸 — Asia/Seoul(KST) 고정, browser-safe.
//
// 대상: created_at·updated_at·generatedAt·fetchedAt·checkedAt·ranAt·조회 시각·
//   실행 시각·last saved/loaded 등 "시각(instant/timestamp)" 메타데이터.
//   ISO UTC 원문(끝에 Z)이 화면에 그대로 노출되던 곳을 항상 서울 표준시로 변환한다.
//
// 규칙:
//   · 브라우저/서버가 어느 시간대에서 실행되든 항상 Asia/Seoul 기준으로 동일하게 표시.
//     (new Date().toLocaleString() 처럼 런타임 TZ 에 의존하지 않는다.)
//   · 형식은 화면별로 제각각 달라지지 않도록 명시적으로 고정한다.
//     기본: "YYYY-MM-DD HH:mm:ss"  예) "2026-07-13 15:30:20"
//   · 숫자는 로케일 무관 아라비아 숫자(ko-KR 표기와 동일)로 zero-pad 고정.
//   · 입력이 없거나 invalid 이면 fallback(기본 "-")을 반환.
//
// 절대 하지 말 것: DB/API 의 ISO UTC 저장값 변경, 서버 내부 비교/정렬/스케줄/주차 경계
//   계산 변경. 이 유틸은 UI 렌더 단계 표시 전용이다.
//
// 클럽 일정(시즌·주차·마감일·공표일 등)은 lib/clubDate.ts(formatClubDate*)를 쓴다.
//   본 유틸은 "클럽 일정이 아닌" 운영/시스템 메타 시각(초 단위 정밀 포함) 전용.

const SEOUL_TIME_ZONE = "Asia/Seoul";

// Intl.DateTimeFormat 은 timeZone 을 지정하면 런타임 TZ 와 무관하게 해당 존의
// 벽시계 시각을 준다. formatToParts 로 각 필드를 뽑아 형식을 직접 조립한다
// (locale/hourCycle 별 문자열 차이에 의존하지 않도록).
const SEOUL_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: SEOUL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23", // 자정을 "24" 가 아닌 "00" 으로 (일부 런타임의 h24 quirk 방지)
});

type SeoulParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "string" && input.trim() === "") return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function seoulParts(date: Date): SeoulParts {
  const parts = SEOUL_PARTS_FORMAT.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export type AdminDateTimeOptions = {
  /** 초 단위까지 표시할지. 기본 true → "YYYY-MM-DD HH:mm:ss". */
  withSeconds?: boolean;
  /** 입력이 없거나 invalid 일 때 반환할 값. 기본 "-". */
  fallback?: string;
};

/**
 * 운영/메타 타임스탬프를 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss" 로 변환한다.
 * withSeconds:false 면 "YYYY-MM-DD HH:mm". 런타임 TZ 와 무관하게 항상 동일.
 *
 *   formatAdminDateTime("2026-07-13T06:30:20.158Z") === "2026-07-13 15:30:20"
 *   formatAdminDateTime("2026-07-13T16:30:00.000Z") === "2026-07-14 01:30:00"
 */
export function formatAdminDateTime(
  input: string | number | Date | null | undefined,
  options: AdminDateTimeOptions = {},
): string {
  const { withSeconds = true, fallback = "-" } = options;
  const date = toDate(input);
  if (!date) return fallback;
  const { year, month, day, hour, minute, second } = seoulParts(date);
  const time = withSeconds ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  return `${year}-${month}-${day} ${time}`;
}

/**
 * 운영/메타 타임스탬프의 날짜 부분만 서울 표준시 "YYYY-MM-DD" 로 변환한다.
 * (시각이 필요 없는 메타 날짜 표시용. 클럽 일정은 formatClubDate 를 쓸 것.)
 */
export function formatAdminDate(
  input: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const date = toDate(input);
  if (!date) return fallback;
  const { year, month, day } = seoulParts(date);
  return `${year}-${month}-${day}`;
}

const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 라인 생성일 등 메타 날짜를 서울 표준시 "YYYY. M. D. (요일)" 로 변환한다(요일 KST 기준).
 * 월/일은 zero-pad 없이, 요일은 한국어 한 글자. (기존 라인 관리 화면 표기 유지 + TZ 고정.)
 */
export function formatAdminDateWithWeekday(
  input: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const date = toDate(input);
  if (!date) return fallback;
  const { year, month, day } = seoulParts(date);
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const weekday = KOREAN_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}. ${m}. ${d}. (${weekday})`;
}
