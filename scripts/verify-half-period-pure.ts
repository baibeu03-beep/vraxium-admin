// 순수 함수 검증 — DB 불필요. lib/teamHalf.ts 의 날짜→반기 변환·정규화를 확인한다.
import { halfKeyForDate, halfKeyToSeasonKeys, HALF_PERIODS, normalizeHalfKeyParam } from "@/lib/teamHalf";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label} → actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

console.log("=== halfKeyForDate (시즌 일정 기준 경계) ===");
check("2026-01-01", halfKeyForDate("2026-01-01"), "2026-H1");
check("2026-06-28 (H1 마지막 날, 전환주차 포함)", halfKeyForDate("2026-06-28"), "2026-H1");
check("2026-06-29 (H2 첫날)", halfKeyForDate("2026-06-29"), "2026-H2");
check("2026-12-27 (H2 마지막 날)", halfKeyForDate("2026-12-27"), "2026-H2");
check("2026-12-28 (다음 해 H1 시작)", halfKeyForDate("2026-12-28"), "2027-H1");
check("2025-12-29 (2026-H1 시작)", halfKeyForDate("2025-12-29"), "2026-H1");

console.log("\n=== halfKeyToSeasonKeys ===");
check("2025-H1", halfKeyToSeasonKeys("2025-H1"), ["2025-winter", "2025-spring"]);
check("2025-H2", halfKeyToSeasonKeys("2025-H2"), ["2025-summer", "2025-autumn"]);
check("invalid", halfKeyToSeasonKeys("garbage"), null);

console.log("\n=== normalizeHalfKeyParam ===");
check("유효값 그대로", normalizeHalfKeyParam("2024-H2", "2026-H2"), "2024-H2");
check("오타 → fallback", normalizeHalfKeyParam("2024-H9", "2026-H2"), "2026-H2");
check("null → fallback", normalizeHalfKeyParam(null, "2026-H2"), "2026-H2");
check("빈 문자열 → fallback", normalizeHalfKeyParam("", "2026-H2"), "2026-H2");
check("범위 밖(2027) → fallback(옵션 10개 고정)", normalizeHalfKeyParam("2027-H1", "2026-H2"), "2026-H2");

console.log("\n=== HALF_PERIODS 고정 10개 ===");
check("길이", HALF_PERIODS.length, 10);
check("첫/끝", [HALF_PERIODS[0], HALF_PERIODS[9]], ["2022-H1", "2026-H2"]);

console.log(`\n${failures === 0 ? "✅ 전부 통과" : `❌ ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
