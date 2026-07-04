// Unit check for the pure countdown formatter (mm:ss + color level thresholds).
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

eq("20분(가득)", formatRemaining(min(20)), { text: "20:00", level: "normal" });
eq("10분", formatRemaining(min(10)), { text: "10:00", level: "normal" });
eq("5분 00초(경계=경고)", formatRemaining(min(5)), { text: "05:00", level: "warning" });
eq("5분 01초(경고 아직 아님=normal)", formatRemaining(min(5) + 1000), { text: "05:01", level: "normal" });
eq("3분", formatRemaining(min(3)), { text: "03:00", level: "warning" });
eq("1분 01초(경고)", formatRemaining(min(1) + 1000), { text: "01:01", level: "warning" });
eq("1분 00초(경계=위험)", formatRemaining(min(1)), { text: "01:00", level: "danger" });
eq("30초(위험)", formatRemaining(30_000), { text: "00:30", level: "danger" });
eq("1초(위험)", formatRemaining(1000), { text: "00:01", level: "danger" });
eq("0(위험)", formatRemaining(0), { text: "00:00", level: "danger" });
eq("음수 clamp", formatRemaining(-5000), { text: "00:00", level: "danger" });

console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
