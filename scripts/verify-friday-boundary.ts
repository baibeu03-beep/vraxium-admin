/**
 * verify-friday-boundary.ts
 * 금요일 경계 정책(2026-06-09 확정) 단일 SoT 검증 — DB 테이블 불필요.
 *   월·화·수·목 → 개설 대상 = 지난 주차 (N-1)
 *   금·토·일   → 개설 대상 = 이번 주차 (N)
 *   ⇒ 목요일은 반드시 N-1.
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-friday-boundary.ts
 *
 * 비교 대상(둘이 동일 경계를 쓰는지):
 *   (a) 강제/드롭다운 SoT: getOpenableWeekStartMs / describeOpenableWeek (cluster4WeekPolicy)
 *   (b) 표시 패널/주차결과: computeOpenNeed (practicalInfoSeasonWeeks)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import {
  describeOpenableWeek,
  getOpenableWeekStartMs,
  getCurrentWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import {
  computeOpenNeed,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const DAY_MS = 86_400_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label} ${extra}`);
  } else {
    fail++;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

// 한 주(월~일) 7일에 대해, 그 주(N) 와 직전 주(N-1) 의 시작일을 기준으로
//   (a) getOpenableWeekStartMs 와 (b) computeOpenNeed.need 가 같은 경계를 쓰는지 검증.
function runWeek(mondayIso: string) {
  const curStart = getCurrentWeekStartMs(`${mondayIso}`);
  if (curStart == null) {
    console.log(`  (시즌 밖 — skip ${mondayIso})`);
    return;
  }
  const prevStart = curStart - 7 * DAY_MS;
  const curStartIso = fmt(curStart);
  const prevStartIso = fmt(prevStart);

  // computeOpenNeed 용 합성 rows (N-1, N).
  const rows: SeasonWeekRow[] = [
    {
      season_name: "2026년도 봄시즌",
      week_number: 13,
      week_start_date: prevStartIso,
      week_end_date: fmt(prevStart + 6 * DAY_MS),
    },
    {
      season_name: "2026년도 봄시즌",
      week_number: 14,
      week_start_date: curStartIso,
      week_end_date: fmt(curStart + 6 * DAY_MS),
    },
  ];

  console.log(`\n주 시작(N)=${curStartIso}, 직전(N-1)=${prevStartIso}`);
  for (let i = 0; i < 7; i++) {
    const dayMs = curStart + i * DAY_MS;
    const iso = fmt(dayMs);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일…6=토
    const dayName = DAY[dow];
    const isMonThu = dow >= 1 && dow <= 4; // 월·화·수·목
    const expected = isMonThu ? "N-1" : "N";
    const expectedStart = isMonThu ? prevStart : curStart;

    // (a) SoT
    const openMs = getOpenableWeekStartMs(iso);
    const aOk = openMs === expectedStart;

    // (b) 표시 패널 — computeOpenNeed 는 로컬 Date 의 getDay 를 쓰므로 동일 요일의
    //     로컬 정오 Date 를 만든다(UTC date 와 요일 일치).
    const [y, m, d] = iso.split("-").map(Number);
    const localNoon = new Date(y, m - 1, d, 12, 0, 0);
    const need = computeOpenNeed(rows, localNoon).need;
    const bStart = need?.week_start_date ?? null;
    const bOk = bStart === (isMonThu ? prevStartIso : curStartIso);

    check(
      `${iso}(${dayName}) → 기대 ${expected}`,
      aOk && bOk,
      `| SoT=${openMs != null ? fmt(openMs) : "null"} need=${bStart} ${aOk === bOk ? "(a==b)" : "(a!=b!!)"}`,
    );
  }
}

async function main() {
  // 실제 시즌 내 주(2026 봄 14/15주차 근방)로 검증.
  runWeek("2026-06-08"); // 현재 주 N (월요일)
  runWeek("2026-06-01"); // 직전 주

  // 목요일 명시 검증 — describeOpenableWeek 의 weekNumber 가 N-1 인지.
  console.log("\n[목요일 명시 검증]");
  const thu = "2026-06-11"; // 2026-06-08 주의 목요일
  const cur = describeOpenableWeek("2026-06-12"); // 금요일 → N
  const thuOpen = describeOpenableWeek(thu); // 목요일 → N-1
  check(
    "금요일(06-12) 개설대상 weekNumber > 목요일(06-11) 개설대상 weekNumber (목=N-1, 금=N)",
    !!cur && !!thuOpen && cur.weekNumber === (thuOpen.weekNumber + 1),
    `| 목=${thuOpen?.weekNumber} 금=${cur?.weekNumber}`,
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
