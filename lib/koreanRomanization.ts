/**
 * 한글 이름 → 영문명 **자동 생성** (auto-generated, NOT an official/passport name).
 *
 * ⚠️ 중요: 이 함수가 만드는 값은 "자동 생성 영문명"이다. 본인이 등록한 공식 영문명이
 *   아니며(여권 표기와 다를 수 있음), 사용자가 직접 영문명을 입력하면 그 값으로 대체된다.
 *   english_name 백필에서 "기존 값이 비어 있는 사용자"에만 사용한다(덮어쓰기 금지).
 *
 * 규칙 (프로젝트에 기존 romanization 함수가 없어 신규 정의 — 2026-06-25):
 *   - 성(姓): 한국에서 통용되는 관용 표기 표(FAMILY_NAME_MAP)를 우선 적용한다.
 *     (예: 이→Lee, 박→Park, 김→Kim, 최→Choi, 윤→Yoon …) 라이브 데이터의 기존
 *     english_name 91건이 이 관용 표기를 쓰므로 카드 표시 일관성을 위해 동일 표를 사용.
 *   - 이름(名): 국립국어원 **국어의 로마자 표기법(Revised Romanization)** 음절 단위 변환.
 *     음절 간 음운동화(자음접변/연음)는 적용하지 않는다(이름 표기는 음절 보존이 일반적).
 *     단, 라이브 데이터에서 압도적으로 통용되는 소수 음절만 GIVEN_SYLLABLE_OVERRIDES 로
 *     관용 표기에 맞춘다(현→hyun, 영→young, 우→woo …). 그 외는 표준 RR.
 *   - 형식: "Family Given" (각 파트 첫 글자 대문자, 이름 음절은 붙여 씀). 예: 김민준 → "Kim Minjun".
 *   - display_name 의 비한글 문자(테스트 마커 'T' 등)는 무시하고 한글 음절만 사용한다.
 *
 * 한글 음절 분해: code = 0xAC00 + (초성*21 + 중성)*28 + 종성.
 */

// 초성 19 (Revised Romanization)
const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
// 중성 21
const MEDIALS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
// 종성 28 (받침 대표음 — 단일 자음 발음으로 단순화)
const FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

// 복성(2글자 성) — 한글 그대로 키. (실데이터 등장 시 관용 표기.)
const COMPOUND_FAMILY_NAMES: Record<string, string> = {
  남궁: "Namgung", 황보: "Hwangbo", 제갈: "Jegal", 선우: "Sunwoo",
  사공: "Sagong", 서문: "Seomun", 독고: "Dokgo", 동방: "Dongbang",
  소봉: "Sobong", 장곡: "Janggok",
};

// 단성(1글자 성) 관용 표기 표.
const FAMILY_NAME_MAP: Record<string, string> = {
  김: "Kim", 이: "Lee", 박: "Park", 최: "Choi", 정: "Jung", 강: "Kang",
  조: "Cho", 윤: "Yoon", 장: "Jang", 임: "Lim", 한: "Han", 오: "Oh",
  서: "Seo", 신: "Shin", 권: "Kwon", 황: "Hwang", 안: "Ahn", 송: "Song",
  류: "Ryu", 유: "Yoo", 홍: "Hong", 전: "Jeon", 고: "Ko", 문: "Moon",
  양: "Yang", 손: "Son", 배: "Bae", 백: "Baek", 허: "Heo", 남: "Nam",
  심: "Sim", 노: "Noh", 하: "Ha", 곽: "Kwak", 성: "Sung", 차: "Cha",
  주: "Joo", 우: "Woo", 구: "Koo", 민: "Min", 나: "Na", 지: "Ji",
  엄: "Eom", 채: "Chae", 원: "Won", 천: "Cheon", 방: "Bang", 공: "Kong",
  현: "Hyun", 함: "Ham", 변: "Byun", 염: "Yeom", 여: "Yeo", 추: "Chu",
  도: "Do", 소: "So", 석: "Seok", 선: "Sun", 설: "Seol", 마: "Ma",
  길: "Gil", 연: "Yeon", 위: "Wi", 표: "Pyo", 명: "Myung", 기: "Ki",
  반: "Ban", 라: "Ra", 왕: "Wang", 금: "Keum", 옥: "Ok", 육: "Yook",
  인: "In", 맹: "Maeng", 제: "Je", 모: "Mo", 봉: "Bong", 사: "Sa",
  부: "Boo", 가: "Ka", 복: "Bok", 동: "Dong", 진: "Jin", 탁: "Tak",
  국: "Kook", 어: "Eo", 은: "Eun", 편: "Pyun", 용: "Yong", 예: "Ye",
  경: "Kyung",
};

// 이름 음절 관용 표기 오버라이드(라이브 데이터 통용형). 그 외는 표준 RR.
const GIVEN_SYLLABLE_OVERRIDES: Record<string, string> = {
  현: "hyun", 영: "young", 우: "woo", 윤: "yoon", 후: "hoo", 혁: "hyuk",
  훈: "hoon", 웅: "woong", 경: "kyung", 성: "sung", 준: "jun", 정: "jung",
  종: "jong", 룡: "ryong", 숙: "sook", 미: "mi", 희: "hee", 의: "eui",
};

function isHangulSyllable(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3;
}

/** 한글 1음절 → RR 로마자(소문자). */
function romanizeSyllable(ch: string): string {
  const code = ch.charCodeAt(0) - 0xac00;
  const ini = Math.floor(code / (21 * 28));
  const med = Math.floor((code % (21 * 28)) / 28);
  const fin = code % 28;
  return INITIALS[ini] + MEDIALS[med] + FINALS[fin];
}

/** 이름(名) 음절 배열 → 붙여 쓴 로마자(첫 글자만 대문자). */
function romanizeGiven(syllables: string[]): string {
  const joined = syllables
    .map((s) => GIVEN_SYLLABLE_OVERRIDES[s] ?? romanizeSyllable(s))
    .join("");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : "";
}

export type RomanizationResult = {
  /** 생성된 "Family Given" 영문명. 생성 불가 시 null. */
  englishName: string | null;
  /** 추출된 한글 음절(비한글 제거 후). */
  hangul: string;
  /** 사용한 성 음절 수(1=단성, 2=복성, 0=성 불명). */
  familyLen: number;
  /** 성 관용표기 적중 여부(false=RR 폴백). */
  familyMapped: boolean;
};

/**
 * 한글 표시명 → 자동 생성 영문명("Family Given").
 *   - display_name 에서 한글 음절만 추출(테스트 마커 'T' 등 비한글 무시).
 *   - 음절이 0개면 생성 불가(null).
 *   - 음절 1개면 성만 있는 것으로 보고 성 표기만 반환.
 */
export function romanizeKoreanName(displayName: string | null | undefined): RomanizationResult {
  const hangul = [...(displayName ?? "")].filter(isHangulSyllable);
  if (hangul.length === 0) {
    return { englishName: null, hangul: "", familyLen: 0, familyMapped: false };
  }

  // 복성(2글자) 우선 판정 → 단성.
  const firstTwo = hangul.slice(0, 2).join("");
  let family: string;
  let familyLen: number;
  let familyMapped: boolean;
  if (hangul.length > 2 && COMPOUND_FAMILY_NAMES[firstTwo]) {
    family = COMPOUND_FAMILY_NAMES[firstTwo];
    familyLen = 2;
    familyMapped = true;
  } else {
    const f = hangul[0];
    if (FAMILY_NAME_MAP[f]) {
      family = FAMILY_NAME_MAP[f];
      familyMapped = true;
    } else {
      // 성 관용표기 미등재 → RR 폴백(첫 글자 대문자).
      const rr = romanizeSyllable(f);
      family = rr.charAt(0).toUpperCase() + rr.slice(1);
      familyMapped = false;
    }
    familyLen = 1;
  }

  const givenSyllables = hangul.slice(familyLen);
  const given = romanizeGiven(givenSyllables);
  const englishName = given ? `${family} ${given}` : family;
  return { englishName, hangul: hangul.join(""), familyLen, familyMapped };
}
