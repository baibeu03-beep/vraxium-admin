/**
 * 검증(순수): 실무 정보 [섹션 0] 상태창 포맷 — 요구사항 예시와 일치하는지.
 *   npx tsx scripts/verify-section0-format.ts
 */
import {
  formatBannerPeriod,
  formatToday,
} from "@/lib/practicalInfoSection0Format";

// 날짜 내부는 NBSP(U+00A0)로 묶여 줄바꿈을 막는다(렌더는 일반 공백과 동일).
// 비교 시 공백 종류(NBSP/일반)는 무시하고 형식 구조만 본다 → 양쪽 모두 \s 를 일반 공백으로 정규화.
const norm = (s: string) => s.replace(/\s/g, String.fromCharCode(32));

let fail = 0;
function eq(label: string, got: string, want: string) {
  const ok = norm(got) === norm(want);
  if (!ok) fail++;
  console.log(
    `${ok ? "✅" : "❌"} ${label} → ${JSON.stringify(got)}${ok ? "" : ` (기대 ${JSON.stringify(want)})`}`,
  );
}

// 2026-07-06 = 월요일 — 클럽 일정 공통 표기 "YY - MM - DD (요일)" (formatClubDate SoT)
eq("formatToday(2026-07-06)", formatToday(new Date(2026, 6, 6)), "26 - 07 - 06 (월)");
eq(
  "formatBannerPeriod 이번주",
  formatBannerPeriod({ year: 2026, seasonName: "여름 시즌", weekNumber: 2 }),
  "26년, 여름 시즌, 2주차",
);
eq(
  "formatBannerPeriod 지난주",
  formatBannerPeriod({ year: 2026, seasonName: "여름 시즌", weekNumber: 1 }),
  "26년, 여름 시즌, 1주차",
);

const lastLabel = formatBannerPeriod({ year: 2026, seasonName: "여름 시즌", weekNumber: 1 });
const act = "위즈덤";
eq(
  "개설 전 문구",
  `지난 주 [${lastLabel}] 의 ${act} 라인이 '개설' 되어야 합니다.`,
  "지난 주 [26년, 여름 시즌, 1주차] 의 위즈덤 라인이 '개설' 되어야 합니다.",
);
eq(
  "개설 후 문구",
  `지난 주 [${lastLabel}] 의 ${act} 라인이 '개설' 되어, 크루 기입이 가능합니다.`,
  "지난 주 [26년, 여름 시즌, 1주차] 의 위즈덤 라인이 '개설' 되어, 크루 기입이 가능합니다.",
);

console.log(fail === 0 ? "\n✅ 배너 포맷 전부 통과" : `\n❌ 실패 ${fail}건`);
process.exit(fail ? 1 : 0);
