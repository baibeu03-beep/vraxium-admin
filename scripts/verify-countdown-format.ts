// Unit check for the pure countdown formatter (한글 단위 표기 + color level thresholds).
//   normal(회색) > 5분 · warning(주황) <= 5분 · danger(빨강) <= 1분
// 실행: npx tsx scripts/verify-countdown-format.ts
import { formatRemaining } from "../lib/adminSessionCountdown";

let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✓" : "✗"} ${label} → ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
};

const min = (m: number) => m * 60 * 1000;

eq("20분(가득)", formatRemaining(min(20)), { text: "20분 0초", level: "normal" });
eq("19분 58초(일반 표시)", formatRemaining(min(19) + 58_000), { text: "19분 58초", level: "normal" });
eq("10분", formatRemaining(min(10)), { text: "10분 0초", level: "normal" });
eq("5분 0초(경계=경고)", formatRemaining(min(5)), { text: "5분 0초", level: "warning" });
eq("5분 1초(경고 아직 아님=normal)", formatRemaining(min(5) + 1000), { text: "5분 1초", level: "normal" });
eq("3분", formatRemaining(min(3)), { text: "3분 0초", level: "warning" });
eq("1분 1초(경고)", formatRemaining(min(1) + 1000), { text: "1분 1초", level: "warning" });
eq("1분 0초(경계=위험)", formatRemaining(min(1)), { text: "1분 0초", level: "danger" });
// 1분 미만 → 분 생략("43초").
eq("43초(분 생략)", formatRemaining(43_000), { text: "43초", level: "danger" });
eq("30초(위험)", formatRemaining(30_000), { text: "30초", level: "danger" });
eq("1초(위험)", formatRemaining(1000), { text: "1초", level: "danger" });
eq("0(위험)", formatRemaining(0), { text: "0초", level: "danger" });
eq("음수 clamp", formatRemaining(-5000), { text: "0초", level: "danger" });
// 1시간 이상(현재 창은 20분이라 실제로는 도달하지 않지만 포맷 규칙은 일반화).
eq("1시간 19분 58초", formatRemaining(min(60) + min(19) + 58_000), { text: "1시간 19분 58초", level: "normal" });
eq("2시간 0분 0초", formatRemaining(min(120)), { text: "2시간 0분 0초", level: "normal" });

console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
