/**
 * 검증(순수): 실무 정보 [섹션 0] 상태창 포맷 — 요구사항 예시와 일치하는지.
 *   npx tsx scripts/verify-section0-format.ts
 */
import {
  formatBannerPeriod,
  formatToday,
} from "@/lib/practicalInfoSection0Format";

let fail = 0;
function eq(label: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(
    `${ok ? "✅" : "❌"} ${label} → ${JSON.stringify(got)}${ok ? "" : ` (기대 ${JSON.stringify(want)})`}`,
  );
}

// 2026-07-06 = 월요일 (요구 예시: "26. 07. 06(월)")
eq("formatToday(2026-07-06)", formatToday(new Date(2026, 6, 6)), "26. 07. 06(월)");
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
