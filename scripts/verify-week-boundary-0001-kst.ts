/**
 * verify-week-boundary-0001-kst.ts
 * 주차/시즌 경계 = 매주 월요일 00:01 KST 로 이동했음을 direct(서버 불필요)로 검증.
 *
 * 검증 항목
 *   1) getCurrentActivityDateIso 가 월요일 00:01 KST 에 다음 주 날짜로 넘어간다
 *      (00:00:30 KST=직전 주, 00:01:30 KST=새 주). 종전 UTC 날짜(09:00 KST 경계)와 대조.
 *   2) 현재 주차 선택(getCurrentWeekStartMs)도 00:01 KST 에 새 주차로 advance.
 *   3) weekStartToBoundaryMs = 월요일 00:01 KST (= 주차시작 00:00 UTC − 9h + 1min).
 *   4) snapshot boundary-stale 판정: 00:01~09:00 KST 사이 재계산된 snapshot 은 신선(herd 없음),
 *      직전 주에 계산된 snapshot 은 stale(1회 재계산).
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-week-boundary-0001-kst.ts
 */
import {
  getCurrentActivityDateIso,
  weekStartToBoundaryMs,
  getSeasonForDate,
  seasonDbKey,
} from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// 2026-06-29(월) = 2026 여름 W1 시작(월요일). KST(UTC+9) 기준 instant 들을 만든다.
const MON = "2026-06-29"; // 월요일
const monWeekStartUtc = Date.UTC(2026, 5, 29); // 2026-06-29T00:00:00Z = 월요일 09:00 KST(추상 주차시작)
// KST 시각 → UTC ms 헬퍼 (KST = UTC+9)
const kst = (iso: string, h: number, m: number, s = 0) =>
  Date.parse(`${iso}T00:00:00Z`) + (h * 3600 + m * 60 + s) * 1000 - 9 * 3600_000;

// 종전(결함) 동작 재현: 현재 날짜 = UTC 날짜(09:00 KST 경계)
const oldUtcDate = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

console.log("=== 1) getCurrentActivityDateIso 경계 = 월요일 00:01 KST ===");
const at0000 = kst(MON, 0, 0, 30); // 월 00:00:30 KST
const at0001 = kst(MON, 0, 1, 30); // 월 00:01:30 KST
const at0900 = kst(MON, 9, 0, 0); //  월 09:00:00 KST
check(
  "월 00:00:30 KST → 아직 직전 주 날짜(2026-06-28, 일)",
  getCurrentActivityDateIso(at0000) === "2026-06-28",
  `new=${getCurrentActivityDateIso(at0000)}`,
);
check(
  "월 00:01:30 KST → 새 주 날짜(2026-06-29, 월)",
  getCurrentActivityDateIso(at0001) === "2026-06-29",
  `new=${getCurrentActivityDateIso(at0001)}`,
);
check(
  "대조: 종전 UTC 날짜는 00:01 KST 에 아직 직전 주(09:00 KST 까지 안 넘어감)",
  oldUtcDate(at0001) === "2026-06-28" && getCurrentActivityDateIso(at0001) === "2026-06-29",
  `old(UTC)=${oldUtcDate(at0001)} vs new(KST)=${getCurrentActivityDateIso(at0001)}`,
);
check(
  "09:00 KST 에는 old/new 둘 다 새 주(종전 경계와 합치)",
  oldUtcDate(at0900) === "2026-06-29" && getCurrentActivityDateIso(at0900) === "2026-06-29",
  `old=${oldUtcDate(at0900)} new=${getCurrentActivityDateIso(at0900)}`,
);

console.log("\n=== 2) 현재 주차 선택도 00:01 KST 에 advance ===");
const prevWeekStartUtc = monWeekStartUtc - 7 * 86_400_000;
check(
  "월 00:00:30 KST → 현재 주차 = 직전 주(2026-06-22 주)",
  getCurrentWeekStartMs(getCurrentActivityDateIso(at0000)) === prevWeekStartUtc,
);
check(
  "월 00:01:30 KST → 현재 주차 = 새 주(2026-06-29 주)",
  getCurrentWeekStartMs(getCurrentActivityDateIso(at0001)) === monWeekStartUtc,
);
const seasonAt0001 = getSeasonForDate(getCurrentActivityDateIso(at0001));
check(
  "월 00:01:30 KST → 현재 시즌 = 2026-summer (W1 시작)",
  !!seasonAt0001 && seasonDbKey(seasonAt0001) === "2026-summer",
  seasonAt0001 ? seasonDbKey(seasonAt0001) : "null",
);

console.log("\n=== 3) weekStartToBoundaryMs = 월요일 00:01 KST ===");
const boundary = weekStartToBoundaryMs(monWeekStartUtc);
check(
  "boundary == 2026-06-28T15:01:00Z (= 월 00:01 KST)",
  boundary === Date.parse("2026-06-28T15:01:00Z"),
  new Date(boundary).toISOString(),
);

console.log("\n=== 4) snapshot boundary-stale 판정(herd 방지) ===");
// now = 월 00:05 KST, 현재 주차 = 새 주, boundary = 월 00:01 KST
const nowMon0005 = kst(MON, 0, 5, 0);
const weekStartNow = getCurrentWeekStartMs(getCurrentActivityDateIso(nowMon0005))!;
const boundaryNow = weekStartToBoundaryMs(weekStartNow);
const snapJustRecomputed = kst(MON, 0, 5, 0); // 방금(00:05 KST) 재계산된 snapshot
const snapLastWeek = Date.parse("2026-06-26T03:00:00Z"); // 직전 주 계산본
check(
  "방금(00:05 KST) 재계산된 snapshot 은 신선(stale 아님) → 재계산 herd 없음",
  !(snapJustRecomputed < boundaryNow),
  `computedAt=${new Date(snapJustRecomputed).toISOString()} >= boundary=${new Date(boundaryNow).toISOString()}`,
);
check(
  "직전 주 계산본은 stale → 1회 재계산",
  snapLastWeek < boundaryNow,
);

console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
if (fail > 0) process.exit(1);
