const INITIALS = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s",
  "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];
const MEDIALS = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa",
  "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
];
const FINALS = [
  "", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l",
  "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t",
];

export const COMPOUND_KOREAN_FAMILY_NAMES: Readonly<Record<string, string>> = {
  남궁: "Namgung",
  황보: "Hwangbo",
  제갈: "Jegal",
  선우: "Sunwoo",
  사공: "Sagong",
  서문: "Seomun",
  독고: "Dokgo",
  동방: "Dongbang",
  소봉: "Sobong",
  장곡: "Janggok",
};

/**
 * 관용 성씨 표기 단일 사전.
 * 2026-07-25 user_profiles.display_name의 정상 한글 인명 631건에서 나타난
 * 첫 음절을 전수 확인했으며, 드문 값도 RR fallback에 의존하지 않도록 포함한다.
 */
export const KOREAN_FAMILY_NAME_ROMANIZATION: Readonly<
  Record<string, string>
> = {
  김: "Kim", 이: "Lee", 박: "Park", 최: "Choi", 정: "Jeong",
  조: "Cho", 강: "Kang", 윤: "Yoon", 장: "Jang", 임: "Lim",
  한: "Han", 오: "Oh", 서: "Seo", 신: "Shin", 권: "Kwon",
  황: "Hwang", 안: "Ahn", 송: "Song", 전: "Jeon", 홍: "Hong",
  류: "Ryu", 유: "Yoo", 고: "Ko", 문: "Moon", 양: "Yang",
  손: "Son", 배: "Bae", 백: "Baek", 허: "Heo", 남: "Nam",
  심: "Sim", 노: "Noh", 하: "Ha", 곽: "Kwak", 성: "Sung",
  차: "Cha", 주: "Joo", 우: "Woo", 구: "Koo", 민: "Min",
  나: "Na", 지: "Ji", 엄: "Eom", 채: "Chae", 원: "Won",
  천: "Cheon", 방: "Bang", 공: "Kong", 현: "Hyun", 함: "Ham",
  변: "Byun", 염: "Yeom", 여: "Yeo", 추: "Chu", 도: "Do",
  소: "So", 석: "Seok", 선: "Sun", 설: "Seol", 마: "Ma",
  길: "Gil", 연: "Yeon", 위: "Wi", 표: "Pyo", 명: "Myung",
  기: "Ki", 반: "Ban", 라: "Ra", 왕: "Wang", 금: "Keum",
  옥: "Ok", 육: "Yook", 인: "In", 맹: "Maeng", 제: "Je",
  모: "Mo", 봉: "Bong", 사: "Sa", 부: "Boo", 가: "Ka",
  복: "Bok", 동: "Dong", 진: "Jin", 탁: "Tak", 국: "Kook",
  어: "Eo", 은: "Eun", 편: "Pyun", 용: "Yong", 예: "Ye",
  경: "Kyung", 견: "Gyeon", 계: "Gye", 범: "Beom", 에: "E",
  태: "Tae", 형: "Hyeong", 목: "Mok",
};

function romanizeSyllable(ch: string): string {
  const code = ch.charCodeAt(0) - 0xac00;
  const initial = Math.floor(code / (21 * 28));
  const medial = Math.floor((code % (21 * 28)) / 28);
  const final = code % 28;
  return INITIALS[initial] + MEDIALS[medial] + FINALS[final];
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

export function romanizeKoreanPersonName(
  displayName: string | null | undefined,
): string {
  const name = displayName?.trim() ?? "";
  if (!/^[가-힣]{2,5}$/.test(name)) return "";

  const compound = Object.keys(COMPOUND_KOREAN_FAMILY_NAMES).find((family) =>
    name.startsWith(family),
  );
  const familyLength = compound ? 2 : 1;
  if (name.length <= familyLength) return "";

  const family =
    (compound
      ? COMPOUND_KOREAN_FAMILY_NAMES[compound]
      : KOREAN_FAMILY_NAME_ROMANIZATION[name[0]]) ??
    titleCase(romanizeSyllable(name[0]));
  const given = titleCase(
    [...name.slice(familyLength)].map(romanizeSyllable).join(""),
  );
  return given ? `${family} ${given}` : "";
}

export type PersonDisplayNames = {
  displayName: string | null;
  englishName: string;
};

export function resolvePersonDisplayNames(
  displayName: string | null | undefined,
  options: { isTestUser?: boolean } = {},
): PersonDisplayNames {
  const koreanName = displayName ?? null;
  const romanizationInput =
    options.isTestUser && koreanName?.startsWith("T")
      ? koreanName.slice(1)
      : koreanName;
  return {
    displayName: koreanName,
    englishName: romanizeKoreanPersonName(romanizationInput),
  };
}

// 기존 스크립트 호환용. 화면 코드는 resolvePersonDisplayNames를 사용한다.
export type RomanizationResult = {
  englishName: string | null;
  hangul: string;
  familyLen: number;
  familyMapped: boolean;
};

export function romanizeKoreanName(
  displayName: string | null | undefined,
): RomanizationResult {
  const name = displayName?.trim() ?? "";
  const englishName = romanizeKoreanPersonName(name);
  const compound = Object.keys(COMPOUND_KOREAN_FAMILY_NAMES).find((family) =>
    name.startsWith(family),
  );
  return {
    englishName: englishName || null,
    hangul: /^[가-힣]{2,5}$/.test(name) ? name : "",
    familyLen: englishName ? (compound ? 2 : 1) : 0,
    familyMapped: Boolean(
      compound || KOREAN_FAMILY_NAME_ROMANIZATION[name[0]],
    ),
  };
}
