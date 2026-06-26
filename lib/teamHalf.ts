// 반기(half) ↔ 시즌(season_key) 매핑 단일 출처 — 순수 함수(DB·서버 의존 없음).
//
// 원칙(2026-06-26 확정):
//   /admin/team-parts/info [섹션.1] 은 "해당 반기가 끝난 시점에 존재하는 팀"을 보여준다.
//   따라서 반기의 조회 기준 시즌 = 그 반기의 "마지막 시즌"이다.
//     {YYYY} 상반기(H1) → {YYYY}-spring   (겨울·봄 중 마지막)
//     {YYYY} 하반기(H2) → {YYYY}-autumn   (여름·가을 중 마지막)
//   season_definitions(연 4시즌)는 그대로 두고, 본 파일이 반기↔시즌 매핑만 더한다.

export type HalfPeriod = "H1" | "H2";

export type SeasonType = "winter" | "spring" | "summer" | "autumn";

const HALF_KEY_RE = /^([0-9]{4})-H([12])$/;

export function isHalfKey(value: unknown): value is string {
  return typeof value === "string" && HALF_KEY_RE.test(value);
}

export function parseHalfKey(
  halfKey: string,
): { year: number; period: HalfPeriod } | null {
  const m = HALF_KEY_RE.exec(halfKey);
  if (!m) return null;
  return { year: Number(m[1]), period: m[2] === "1" ? "H1" : "H2" };
}

// 반기 → 그 반기의 마지막 시즌 키. ([섹션.1] 조회 기준)
export function halfKeyToLastSeasonKey(halfKey: string): string | null {
  const parsed = parseHalfKey(halfKey);
  if (!parsed) return null;
  const season = parsed.period === "H1" ? "spring" : "autumn";
  return `${parsed.year}-${season}`;
}

// 시즌 키 → 그 시즌이 속한 반기 키.
//   겨울·봄 → H1, 여름·가을 → H2. 연도는 season_key 접두(2026-winter → 2026-H1).
export function seasonKeyToHalfKey(seasonKey: string): string | null {
  const m = /^([0-9]{4})-(winter|spring|summer|autumn)$/.exec(seasonKey);
  if (!m) return null;
  const year = m[1];
  const type = m[2] as SeasonType;
  const period: HalfPeriod = type === "winter" || type === "spring" ? "H1" : "H2";
  return `${year}-${period}`;
}

// '2026-H1' → '2026 상반기'
export function halfLabel(halfKey: string): string {
  const parsed = parseHalfKey(halfKey);
  if (!parsed) return halfKey;
  return `${parsed.year} ${parsed.period === "H1" ? "상반기" : "하반기"}`;
}

// 정렬용 비교(최신 반기가 앞). halfKey 문자열은 'YYYY-H#' 라 사전식 == 시간식.
export function compareHalfKeyDesc(a: string, b: string): number {
  return b.localeCompare(a);
}
