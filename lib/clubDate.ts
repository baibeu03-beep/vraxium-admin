// 클럽 일정 날짜 표기 공통 유틸 — browser-safe, DB 접근 없음.
//
// 어드민 전역에서 "클럽 일정"(시즌·주차·기간·마감일·공표일·시작일·종료일·개설일 등)
// 날짜는 모두 아래 단일 형식으로 표시한다:
//
//   YY - MM - DD (요일)        예) "26 - 03 - 03 (화)"
//
// 규칙:
//   · 연도는 2자리, 월/일은 반드시 2자리(zero-pad).
//   · 구분자는 " - " (앞뒤 공백 포함).
//   · 요일은 한국어 한 글자(일/월/화/수/목/금/토)를 괄호로 뒤에 붙인다.
//   · 날짜가 없거나 invalid 이면 fallback("-" 기본)을 반환한다.
//
// 제외 대상(이 유틸을 쓰지 말 것): 크루 생년월일, 프로필 birth_date,
//   계정 생성일/연락처 등 "클럽 일정이 아닌" 일반 메타 날짜.
//
// 타임존: date-only 문자열("YYYY-MM-DD")은 달력 날짜 그대로 해석한다.
//   시각(timestamp/ISO instant)은 KST(UTC+9) 기준 달력 날짜로 환산해 표시한다.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

type Ymd = { y: number; m: number; d: number };

function kstParts(date: Date): Ymd {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    y: kst.getUTCFullYear(),
    m: kst.getUTCMonth() + 1,
    d: kst.getUTCDate(),
  };
}

function toYmd(input: string | number | Date | null | undefined): Ymd | null {
  if (input == null) return null;

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;
    // date-only: 달력 날짜 그대로 (타임존 시프트 금지)
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dateOnly) {
      return { y: +dateOnly[1], m: +dateOnly[2], d: +dateOnly[3] };
    }
    // ISO instant 등 → KST 환산
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return kstParts(parsed);
    // "YYYY-MM-DD..." 접두 폴백
    const prefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (prefix) return { y: +prefix[1], m: +prefix[2], d: +prefix[3] };
    return null;
  }

  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return kstParts(date);
}

/**
 * 클럽 일정 날짜를 "YY - MM - DD (요일)" 형식 문자열로 변환한다.
 * 입력이 없거나 invalid 이면 fallback(기본 "-")을 반환한다.
 */
export function formatClubDate(
  input: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const parts = toYmd(input);
  if (!parts) return fallback;
  const { y, m, d } = parts;
  const yy = String(((y % 100) + 100) % 100).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${yy} - ${mm} - ${dd} (${weekday})`;
}

/**
 * 시각까지 함께 보여주던 클럽 일정(공표일·검수일·마감일·예약 검수시각 등)을
 * "YY - MM - DD (요일) HH:mm" 형식으로 변환한다. 시각은 KST(UTC+9) 기준.
 *
 * 주의: 원래 시각이 없던 순수 날짜에는 이 함수를 쓰지 말고 formatClubDate 를 쓴다
 *   (없던 시각을 새로 붙이지 않는다). date-only 문자열이 들어오면 시각 없이
 *   날짜만 반환한다.
 */
export function formatClubDateTime(
  input: string | number | Date | null | undefined,
  fallback = "-",
): string {
  if (input == null) return fallback;
  const datePart = formatClubDate(input, "");
  if (!datePart) return fallback;

  // date-only 문자열은 시각이 없음 → 날짜만 반환
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return datePart;
  }

  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return datePart;
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${datePart} ${hh}:${mi}`;
}

/**
 * 기간(시작~종료)을 "YY - MM - DD (요일) {sep} YY - MM - DD (요일)" 로 변환한다.
 * 한쪽만 있으면 그 한쪽만, 둘 다 없으면 fallback 을 반환한다.
 */
export function formatClubDateRange(
  start: string | number | Date | null | undefined,
  end: string | number | Date | null | undefined,
  options: { separator?: string; fallback?: string } = {},
): string {
  const { separator = " → ", fallback = "-" } = options;
  const s = formatClubDate(start, "");
  const e = formatClubDate(end, "");
  if (s && e) return `${s}${separator}${e}`;
  return s || e || fallback;
}
