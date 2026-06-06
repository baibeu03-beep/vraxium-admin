// 진단(read-only): 후보 주차 날짜의 seasonCalendar 하드코딩 규칙 판정.
//   npx tsx scripts/diag-candidate-week-calendar.ts
import {
  getSeasonForDate,
  getSeasonWeekStatusForDate,
  isTransitionWeekStart,
  seasonDbKey,
} from "@/lib/seasonCalendar";

const dates = [
  "2025-06-23",
  "2025-06-30",
  "2025-07-07",
  "2025-07-14",
  "2025-07-21",
  "2025-07-28",
  "2025-08-04",
  "2025-08-11",
  "2025-08-18",
  "2025-08-25",
  "2025-09-01",
];
for (const d of dates) {
  const s = getSeasonForDate(d);
  console.log(
    `${d} -> season=${s ? seasonDbKey(s) : null} status=${getSeasonWeekStatusForDate(d)} transition=${isTransitionWeekStart(d)}`,
  );
}
