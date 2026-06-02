// cluster4_lines.period_label 표기 통일 — 단일 formatter / resolver. browser-safe, DB 접근 없음.
//
// 목표 표기: "{YY} {시즌명} {N}주차"  (예: 2026년 겨울 5주차 → "26 겨울 5주차")
//   - YY     : weeks.iso_year 의 끝 2자리      (2026 → "26")
//   - 시즌명 : weeks.season_key 의 시즌 suffix → 한글 (winter→겨울 …)
//   - N      : weeks.week_number              (시즌 상대 주차, SoT)
//
// SoT 우선순위 (요구사항):
//   1) week_id → weeks 조인
//   2) weeks.iso_year     → YY
//   3) weeks.season_key   → 시즌명
//   4) weeks.week_number  → N
//
// ⛔ start_date 기반 자체 계산 금지. 직접 입력값(Excel 셀)·ISO 표기도 신뢰하지 않는다.
//    오직 weeks 의 iso_year / season_key / week_number 만 사용한다.

const SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};

// 순수 string builder — 세 입력으로부터 정규 표기를 만든다.
//   formatKoreanPeriodLabel({ year: 2026, seasonName: "겨울", weekNumber: 5 }) → "26 겨울 5주차"
export function formatKoreanPeriodLabel(input: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  const yy = String(((input.year % 100) + 100) % 100).padStart(2, "0");
  return `${yy} ${input.seasonName} ${input.weekNumber}주차`;
}

export type PeriodLabelWeekInput = {
  isoYear?: number | null; // weeks.iso_year (시즌 연도)
  seasonKey?: string | null; // weeks.season_key (예: "2026-winter")
  weekNumber?: number | null; // weeks.week_number (시즌 상대 주차, SoT)
};

function seasonNameFromSeasonKey(seasonKey: string): string | null {
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_TO_KO[part];
    if (ko) return ko;
  }
  return null;
}

// week 행(iso_year / season_key / week_number)으로부터 정규 period_label 을 생성한다.
// 세 값 중 하나라도 결정 못 하면 null (호출부에서 처리). start_date 폴백은 쓰지 않는다.
export function resolvePeriodLabelFromWeek(
  week: PeriodLabelWeekInput,
): string | null {
  const year = typeof week.isoYear === "number" ? week.isoYear : null;
  const seasonName = week.seasonKey ? seasonNameFromSeasonKey(week.seasonKey) : null;
  const weekNumber =
    typeof week.weekNumber === "number" && week.weekNumber > 0
      ? week.weekNumber
      : null;

  if (year == null || !seasonName || weekNumber == null) return null;
  return formatKoreanPeriodLabel({ year, seasonName, weekNumber });
}
