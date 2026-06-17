// ===================================================================
// 크루 코드 순수 로직 검증(DB/env 불필요). lib/crewCode.ts 단위 테스트.
//   실행: npx tsx scripts/verify-crew-code-logic.ts
// ===================================================================
import {
  assignNameOrders,
  birthYearDigits,
  buildCrewCode,
  clubDigit,
  effectiveGrade,
  genderDigit,
  seasonDigit,
  seasonOrdinal,
  SUMMER_2026_ORDINAL,
  type NameOrderCrew,
} from "@/lib/crewCode";

let fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (!ok) fail += 1;
}

// 자릿값.
eq(birthYearDigits("2003-05-01"), "03", "년생 2003→03");
eq(birthYearDigits("1998-12-31"), "98", "년생 1998→98");
eq(genderDigit("여"), 6, "성별 여→6");
eq(genderDigit("남"), 5, "성별 남→5");
eq(genderDigit("남자"), 5, "성별 남자→5");
eq(clubDigit("encre"), 1, "클럽 엥크레→1");
eq(clubDigit("oranke"), 2, "클럽 오랑캐→2");
eq(clubDigit("phalanx"), 3, "클럽 팔랑크스→3");
eq(clubDigit(null), null, "클럽 공통→null");
eq(seasonDigit("winter"), 1, "시즌 겨울→1");
eq(seasonDigit("spring"), 2, "시즌 봄→2");
eq(seasonDigit("summer"), 3, "시즌 여름→3");
eq(seasonDigit("autumn"), 4, "시즌 가을→4");

// 전체 코드 — 스펙 예시 036011-1263022 재현.
//   03 년생 · 6 여 · 011 이름순 · 1 엥크레 · 26 YY · 3 여름 · 02 WW · 2 성적
eq(
  buildCrewCode({
    birthDate: "2003-07-15",
    gender: "여",
    orgSlug: "encre",
    startWeek: { year: 2026, seasonType: "summer", weekNumber: 2 },
    nameOrder: 11,
    grade: 2,
  }),
  "036011-1263022",
  "전체 코드 예시1 036011-1263022",
);

// 두 번째 예시 025002-3254035: 02 년생 · 5 남 · 002 이름순 · 3 팔랑크스 · 25 · 4 가을 · 03 WW · 5 성적
eq(
  buildCrewCode({
    birthDate: "2002-01-09",
    gender: "남",
    orgSlug: "phalanx",
    startWeek: { year: 2025, seasonType: "autumn", weekNumber: 3 },
    nameOrder: 2,
    grade: 5,
  }),
  "025002-3254035",
  "전체 코드 예시2 025002-3254035",
);

// 필수값 누락 → null.
eq(
  buildCrewCode({ birthDate: null, gender: "남", orgSlug: "encre", startWeek: { year: 2026, seasonType: "summer", weekNumber: 1 }, nameOrder: 1, grade: 3 }),
  null,
  "birth 누락→null",
);
eq(
  buildCrewCode({ birthDate: "2003-01-01", gender: "남", orgSlug: null, startWeek: { year: 2026, seasonType: "summer", weekNumber: 1 }, nameOrder: 1, grade: 3 }),
  null,
  "org 공통→null",
);

// 지원성적: 2026 여름 전=3, 이후=application_grade ?? 3.
eq(effectiveGrade({ year: 2025, seasonType: "autumn", weekNumber: 1 }, 5), 3, "2025가을 시작→무조건 3");
eq(effectiveGrade({ year: 2026, seasonType: "spring", weekNumber: 1 }, 4), 3, "2026봄 시작→3");
eq(effectiveGrade({ year: 2026, seasonType: "summer", weekNumber: 1 }, 4), 4, "2026여름 시작→평가값4");
eq(effectiveGrade({ year: 2026, seasonType: "summer", weekNumber: 1 }, null), 3, "2026여름+미입력→3");
eq(effectiveGrade({ year: 2026, seasonType: "autumn", weekNumber: 1 }, 2), 2, "2026가을→평가값2");
eq(seasonOrdinal(2026, "summer"), SUMMER_2026_ORDINAL, "컷오프 ordinal 일치");

// 이름순 자동 파생 — (org+시작주차) 파티션 내 가나다 001..
const crews: NameOrderCrew[] = [
  { userId: "u-na", orgSlug: "encre", startWeekKey: "2026-summer-2", displayName: "나리" },
  { userId: "u-ga", orgSlug: "encre", startWeekKey: "2026-summer-2", displayName: "가은" },
  { userId: "u-da", orgSlug: "encre", startWeekKey: "2026-summer-2", displayName: "다온" },
  // 다른 주차 → 별도 파티션 001 부터.
  { userId: "u-other", orgSlug: "encre", startWeekKey: "2026-summer-3", displayName: "가은" },
  // 다른 org → 별도 파티션.
  { userId: "u-org", orgSlug: "oranke", startWeekKey: "2026-summer-2", displayName: "가은" },
  // 시작주차 미해석 → 제외.
  { userId: "u-skip", orgSlug: "encre", startWeekKey: null, displayName: "하늘" },
];
const orders = assignNameOrders(crews);
eq(orders.get("u-ga"), 1, "가은=001(가나다 1)");
eq(orders.get("u-na"), 2, "나리=002");
eq(orders.get("u-da"), 3, "다온=003");
eq(orders.get("u-other"), 1, "다른 주차 가은=001");
eq(orders.get("u-org"), 1, "다른 org 가은=001");
eq(orders.has("u-skip"), false, "시작주차 미해석 제외");

console.log("─".repeat(40));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
