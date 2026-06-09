// 실무 정보 라인 개설 [섹션 0] 상태창 표기 포맷 — 순수 함수(browser-safe, DB 무관).
// 컴포넌트와 검증 스크립트가 동일 코드를 공유한다.

export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

// "26. 07. 06(월)" — 주어진 날짜의 2자리연도. 0패딩 월/일 + 한글 요일.
export function formatToday(d: Date): string {
  const yy = String(((d.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}. ${mm}. ${dd}(${DAY_NAMES[d.getDay()]})`;
}

// "26년, 여름 시즌, 2주차" — seasonName 은 DTO 값("여름 시즌")을 그대로 사용한다.
export function formatBannerPeriod(input: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  const yy = String(((input.year % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년, ${input.seasonName}, ${input.weekNumber}주차`;
}

// ── 로그창 표기 포맷 ───────────────────────────────────────────────────────

// season_key suffix → 한글 시즌명. (lib/cluster4PeriodLabel 의 매핑과 동일 — 작은 안정 상수.)
const SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};

function seasonNameKo(seasonKey: string | null | undefined): string | null {
  if (!seasonKey) return null;
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_TO_KO[part];
    if (ko) return ko;
  }
  return null;
}

// "26년 여름 시즌 1주차" — weeks.iso_year / season_key / week_number 로부터(SoT).
export function formatLogPeriodLabel(input: {
  isoYear: number | null;
  seasonKey: string | null;
  weekNumber: number | null;
}): string {
  const season = seasonNameKo(input.seasonKey);
  if (input.isoYear == null || !season || input.weekNumber == null) {
    return "기간 미상";
  }
  const yy = String(((input.isoYear % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년 ${season} 시즌 ${input.weekNumber}주차`;
}

// "26.06.01(월), 17:23" — timestamptz 를 클라이언트 로컬(KST) 기준 YY.MM.DD(요일), HH:mm(24h).
export function formatLogDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yy = String(((d.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yy}.${mm}.${dd}(${DAY_NAMES[d.getDay()]}), ${hh}:${min}`;
}

export type OpeningLogAction = "open" | "cancel";
export const OPENING_LOG_ACTION_LABEL: Record<OpeningLogAction, string> = {
  open: "개설 완료",
  cancel: "개설 취소",
};
