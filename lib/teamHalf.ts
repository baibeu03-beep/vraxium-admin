// 반기(half) ↔ 시즌(season_key) 매핑 단일 출처 — 순수 함수(DB·서버 의존 없음).
//
// 원칙(2026-06-26 확정):
//   /admin/team-parts/info [섹션.1] 은 "해당 반기가 끝난 시점에 존재하는 팀"을 보여준다.
//   따라서 반기의 조회 기준 시즌 = 그 반기의 "마지막 시즌"이다.
//     {YYYY} 상반기(H1) → {YYYY}-spring   (겨울·봄 중 마지막)
//     {YYYY} 하반기(H2) → {YYYY}-autumn   (여름·가을 중 마지막)
//   season_definitions(연 4시즌)는 그대로 두고, 본 파일이 반기↔시즌 매핑만 더한다.
//
// 반기 경계는 **달력 월이 아니라 시즌 일정 기준**이다(2026-07-31 확정). 예:
//   2026-H1 = 2025-12-29(겨울 시작) ~ 2026-06-28(봄+전환주차 끝)
//   2026-H2 = 2026-06-29(여름 시작) ~ 2026-12-27(가을+전환주차 끝)
// `resolveCurrentHalfKey()`(adminTeamHalvesData.ts, DB `season_definitions` 조회)와
// `halfKeyForDate()`(아래, 순수 캘린더)는 같은 앵커(seasonCalendar ANCHOR_MS)를 쓰므로
// 항상 같은 결과를 낸다 — 두 SoT 로 갈라지지 않는다.

import {
  getSeasonForDate,
  seasonDbKey,
  type Season,
} from "@/lib/seasonCalendar";

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

// 반기 → 두 시즌 키(방학 → 학기 순). 파트×주차 존재표 x축(약 26주) 구성용.
//   상반기(H1) = 겨울(방학) + 봄(학기), 하반기(H2) = 여름(방학) + 가을(학기).
export function halfKeyToSeasonKeys(halfKey: string): [string, string] | null {
  const parsed = parseHalfKey(halfKey);
  if (!parsed) return null;
  return parsed.period === "H1"
    ? [`${parsed.year}-winter`, `${parsed.year}-spring`]
    : [`${parsed.year}-summer`, `${parsed.year}-autumn`];
}

// 시즌 키 → 한글 시즌명(년도 생략). 파트×주차 존재표 x축 라벨용.
export function seasonKeyToSeasonLabel(seasonKey: string): string {
  const m = /-(winter|spring|summer|autumn)$/.exec(seasonKey);
  if (!m) return seasonKey;
  return { winter: "겨울", spring: "봄", summer: "여름", autumn: "가을" }[
    m[1] as SeasonType
  ];
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

// 다음 반기 키. H1 → 같은 해 H2, H2 → 다음 해 H1.
export function nextHalfKey(halfKey: string): string | null {
  const p = parseHalfKey(halfKey);
  if (!p) return null;
  return p.period === "H1" ? `${p.year}-H2` : `${p.year + 1}-H1`;
}

// 편집 가능 판정의 단일 SoT — 현재 반기 OR 다음 반기(과거는 조회 전용).
//   프론트 disabled·백엔드 write gate·canEdit 판정이 모두 이 함수를 거친다.
export function isEditableHalf(
  halfKey: string,
  currentHalfKey: string | null,
): boolean {
  if (!currentHalfKey) return false;
  return halfKey === currentHalfKey || halfKey === nextHalfKey(currentHalfKey);
}

// ── "해당 시기" 드롭다운 공용 SoT (2026-07-31) ────────────────────────────────
//   /admin/team-parts/info/* 전체(상위 목록·클럽 상세·팀 상세)가 이 상수·함수를 공유한다.
//   화면마다 옵션 배열을 복붙하지 않는다(종전 ClubTeamDetail.tsx 로컬 HALF_OPTIONS 흡수).

// 고정 10개(2022-H1~2026-H2). DB 에 데이터가 없는 반기도 선택지로는 항상 노출한다
// (없으면 "기록 없음" — lib/halfPeriod.ts 의 rosterSource/structureSource 가 판정).
export const HALF_PERIODS = [
  "2022-H1",
  "2022-H2",
  "2023-H1",
  "2023-H2",
  "2024-H1",
  "2024-H2",
  "2025-H1",
  "2025-H2",
  "2026-H1",
  "2026-H2",
] as const;

export type HalfPeriodKey = (typeof HALF_PERIODS)[number];

export function isHalfPeriodOption(value: unknown): value is HalfPeriodKey {
  return typeof value === "string" && (HALF_PERIODS as readonly string[]).includes(value);
}

// 날짜 → 반기. **순수 함수**(DB 접근 없음) — seasonCalendar 의 앵커 기반 캘린더로만 계산한다.
//   resolveCurrentHalfKey()(DB `season_definitions` 조회)와 같은 앵커를 쓰므로 항상 일치한다
//   (전환 주차 경계 포함 실측 확인됨 — 2026-06-28=H1 마지막 날, 2026-06-29=H2 첫날).
export function halfKeyForDate(dateIso: string): string {
  const season: Season | null = getSeasonForDate(dateIso);
  if (!season) {
    // 캘린더 범위 밖(극단적 과거/미래) — 연도만으로 최선 추정(문서화된 폴백).
    const year = Number(dateIso.slice(0, 4));
    const month = Number(dateIso.slice(5, 7));
    return `${year}-${month <= 6 ? "H1" : "H2"}`;
  }
  return seasonKeyToHalfKey(seasonDbKey(season)) ?? `${season.year}-H1`;
}

// '2026-H2' → '2026년도 하반기' (드롭다운 표시 전용 어휘 — halfLabel()의 '2026 하반기'와는
//   다른 화면이 쓰는 별개 어휘라 기존 함수를 바꾸지 않고 새로 둔다). 연도는 4자리 그대로 표기한다
//   (2026-08-03 확정 — 종전 '26년도'처럼 두 자리로 줄이지 않는다).
export function halfLabelKo(halfKey: string): string {
  const parsed = parseHalfKey(halfKey);
  if (!parsed) return halfKey;
  return `${parsed.year}년도 ${parsed.period === "H1" ? "상반기" : "하반기"}`;
}

// URL 쿼리 period 값 정규화 — 유효하지 않으면(오타·범위 밖·미지정) fallback(보통 현재 반기)으로
//   안전 보정한다. 400 오류를 내지 않는다(요구: 잘못된 값도 화면은 항상 뜬다).
export function normalizeHalfKeyParam(
  raw: string | null | undefined,
  fallback: string,
): string {
  const trimmed = raw?.trim();
  return trimmed && isHalfPeriodOption(trimmed) ? trimmed : fallback;
}
