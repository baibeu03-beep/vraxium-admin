// 크루 코드 생성 — 순수 로직(SoT). DB 접근 없음(테스트 용이).
// ──────────────────────────────────────────────────────────────────────────
// 공식: (년생2)(성별1)(이름순3)-(클럽1)(YY2 시즌1 WW2)(성적1)
//   예) 036011-1263022
//     03 년생(birth_date 끝 2자리) · 6 성별(남=5/여=6) · 011 이름순
//     1 클럽(엥크레=1/오랑캐=2/팔랑크스=3) · 26 시작연도 · 3 시즌(겨울1/봄2/여름3/가을4)
//     02 시작 시즌주차 · 2 지원 평가 성적(1~5)
//   - 앞 6자리: 본인 정체성, 뒤 7자리: 입회 맥락(클럽+시작주차)+지원성적.
//   - 이름순은 (organization_slug + 활동 시작 주차) 파티션 내 이름 가나다순 001..(assignNameOrders).
// 필수 파생값(년생/성별/클럽/시작주차) 중 하나라도 없으면 null — 호출자는 "미생성" 처리.
// ──────────────────────────────────────────────────────────────────────────

export const CREW_CODE_FORMULA_VERSION = 1;

export type SeasonType = "winter" | "spring" | "summer" | "autumn";

// 시즌 → 코드 digit(공식). 겨울=1·봄=2·여름=3·가을=4.
const SEASON_DIGIT: Record<SeasonType, number> = {
  winter: 1,
  spring: 2,
  summer: 3,
  autumn: 4,
};

// 시즌 → 연중 순서(달력순). 지원성적 컷오프(2026 여름) 비교용 — digit 과 다르다.
const SEASON_ORDER: Record<SeasonType, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  autumn: 3,
};

// 클럽(organization_slug) → 코드 digit.
const CLUB_DIGIT: Record<string, number> = {
  encre: 1,
  oranke: 2,
  phalanx: 3,
};

// 활동 시작 주차(시즌 상대) — weeks.season_key(연도+시즌) + week_number 에서 해석한 의미값.
export type StartWeek = {
  year: number; // 시즌 연도(season_key prefix). 전환주차 보정을 위해 iso_year 가 아닌 season 연도 사용.
  seasonType: SeasonType;
  weekNumber: number; // 시즌 상대 주차(SoT).
};

export type CrewCodeInput = {
  birthDate: string | null; // "YYYY-MM-DD"
  gender: string | null;
  orgSlug: string | null;
  startWeek: StartWeek | null;
  nameOrder: number; // 1-based 이름순(assignNameOrders 결과)
  grade: number; // 최종 지원 평가 성적(effectiveGrade 결과, 1~5)
};

export function isSeasonType(v: unknown): v is SeasonType {
  return v === "winter" || v === "spring" || v === "summer" || v === "autumn";
}

// 시즌 chronological ordinal = year*10 + 연중순서. 2026 여름 = 20262.
export function seasonOrdinal(year: number, seasonType: SeasonType): number {
  return year * 10 + SEASON_ORDER[seasonType];
}

// 지원 평가 성적 컷오프 = 2026 여름 시즌. 이 시즌 "전" 입회/기존 활동자 = 전부 3.
export const SUMMER_2026_ORDINAL = seasonOrdinal(2026, "summer");

// birth_date("YYYY-MM-DD") → 년생 2자리("03"). 파싱 불가 시 null.
export function birthYearDigits(birthDate: string | null): string | null {
  if (!birthDate) return null;
  const m = String(birthDate).trim().match(/^(\d{4})-\d{2}-\d{2}/);
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year)) return null;
  return String(year % 100).padStart(2, "0");
}

// 성별 → digit(남=5, 여=6). "남"/"남자"/"male"/"M" → 5, "여"/"여자"/"female"/"F" → 6.
export function genderDigit(gender: string | null): number | null {
  if (!gender) return null;
  const g = gender.trim().toLowerCase();
  if (g.startsWith("남") || g === "m" || g === "male") return 5;
  if (g.startsWith("여") || g === "f" || g === "female") return 6;
  return null;
}

// organization_slug → 클럽 digit. 미매핑(공통/NULL) → null.
export function clubDigit(orgSlug: string | null): number | null {
  if (!orgSlug) return null;
  return CLUB_DIGIT[orgSlug] ?? null;
}

export function seasonDigit(seasonType: SeasonType): number {
  return SEASON_DIGIT[seasonType];
}

// 지원 평가 성적 확정. 2026 여름 이전 시작 = 3, 이후 = application_grade ?? 3.
export function effectiveGrade(
  startWeek: StartWeek | null,
  applicationGrade: number | null,
): number {
  const stored =
    typeof applicationGrade === "number" &&
    Number.isInteger(applicationGrade) &&
    applicationGrade >= 1 &&
    applicationGrade <= 5
      ? applicationGrade
      : null;
  if (!startWeek) return stored ?? 3;
  const ord = seasonOrdinal(startWeek.year, startWeek.seasonType);
  if (ord < SUMMER_2026_ORDINAL) return 3;
  return stored ?? 3;
}

// 최종 크루 코드 문자열. 필수 파생값 누락 시 null.
export function buildCrewCode(input: CrewCodeInput): string | null {
  const yy = birthYearDigits(input.birthDate);
  const gd = genderDigit(input.gender);
  const cd = clubDigit(input.orgSlug);
  const sw = input.startWeek;
  if (yy == null || gd == null || cd == null || sw == null) return null;
  if (!Number.isInteger(input.nameOrder) || input.nameOrder < 1) return null;
  if (!Number.isInteger(sw.weekNumber) || sw.weekNumber < 0) return null;

  const nameOrder = String(input.nameOrder).padStart(3, "0");
  const startYY = String(sw.year % 100).padStart(2, "0");
  const sd = seasonDigit(sw.seasonType);
  const ww = String(sw.weekNumber).padStart(2, "0");
  const grade = String(input.grade);

  // (년생)(성별)(이름순) - (클럽)(YY 시즌 WW)(성적)
  return `${yy}${gd}${nameOrder}-${cd}${startYY}${sd}${ww}${grade}`;
}

// 이름순 자동 파생.
//   파티션 = (organization_slug + 활동 시작 주차). 같은 파티션 안에서 이름 가나다(ko) 정렬 →
//   001,002,003... 부여. 같은 이름은 userId 로 안정 tie-break.
//   startWeekKey 가 없는(시작주차 미해석) 크루는 코드 생성 대상이 아니므로 제외한다.
export type NameOrderCrew = {
  userId: string;
  orgSlug: string | null;
  startWeekKey: string | null; // 예) "2026-summer-2" — 시작주차 식별자(없으면 제외)
  displayName: string;
};

export function partitionKey(orgSlug: string | null, startWeekKey: string): string {
  return `${orgSlug ?? "_"}|${startWeekKey}`;
}

export function assignNameOrders(crews: NameOrderCrew[]): Map<string, number> {
  const byPartition = new Map<string, NameOrderCrew[]>();
  for (const c of crews) {
    if (!c.startWeekKey) continue;
    const key = partitionKey(c.orgSlug, c.startWeekKey);
    const list = byPartition.get(key) ?? [];
    list.push(c);
    byPartition.set(key, list);
  }

  const out = new Map<string, number>();
  for (const list of byPartition.values()) {
    const sorted = [...list].sort((a, b) => {
      const c = a.displayName.localeCompare(b.displayName, "ko");
      if (c !== 0) return c;
      return a.userId.localeCompare(b.userId);
    });
    sorted.forEach((crew, idx) => out.set(crew.userId, idx + 1));
  }
  return out;
}
