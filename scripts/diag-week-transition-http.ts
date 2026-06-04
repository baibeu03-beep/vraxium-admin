/**
 * READ-ONLY: 주차 경계 전환 검증 — 실제 HTTP API 응답 수집 (direct 와 비교용).
 *
 *   npx tsx --env-file=.env.local scripts/diag-week-transition-http.ts <testerId> <realId>
 *
 *   - /api/cluster4/weekly-growth?demoUserId=<tester>            … demo 경로(LIVE 계산)
 *   - /api/cluster4/weekly-growth?demoUserId=<tester>&userId=<real> … 일반 유저 데이터(동일 getWeeklyGrowth 합류)
 *   - /api/cluster4/weekly-cards?userId=…  (x-internal-api-key)  … snapshot-only 경로
 */
const BASE = process.env.DIAG_BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

const tester = process.argv[2]!;
const real = process.argv[3]!;

function fmtGrowth(json: any) {
  const d = json.data ?? {};
  const cw = d.currentWeekInfo ?? {};
  const g = d.growthSummary ?? {};
  const ss = d.seasonSummary ?? {};
  const cards = d.weeklyCards ?? [];
  const newest = cards[0] ?? cards[cards.length - 1];
  return [
    `  currentWeekInfo: ${cw.year} ${cw.seasonName} ${cw.weekNumber}주차 (${cw.startDate}~${cw.endDate}) status=${cw.status}`,
    `  growthSummary: available=${g.availableWeeks} approved=${g.approvedWeeks} failed=${g.failedWeeks} rest=${g.restWeeks} endStatus=${g.endStatus} end="${g.endWeekDisplay}"`,
    `  seasonSummary: ${ss.displayTitle} status=${ss.status}(${ss.statusLabel}) ${ss.startDate}~${ss.endDate}`,
    `  seasonActivityStatuses: ${(d.seasonActivityStatuses ?? []).length}건`,
    `  weeklyCards: ${cards.length}장`,
  ].join("\n");
}

async function main() {
  console.log(`BASE=${BASE} 실행(UTC)=${new Date().toISOString()}`);

  // 1) demo 경로 — 테스터 본인
  {
    const res = await fetch(`${BASE}/api/cluster4/weekly-growth?demoUserId=${tester}`);
    const json: any = await res.json();
    console.log(`\n[HTTP] weekly-growth demoUserId=tester → ${res.status} success=${json.success}`);
    if (json.success) console.log(fmtGrowth(json));
    else console.log("  error:", json.error);
  }

  // 2) demo 인증 + 일반 유저 대상 (getWeeklyGrowth 동일 합류 — 일반 경로 프록시)
  {
    const res = await fetch(
      `${BASE}/api/cluster4/weekly-growth?demoUserId=${tester}&userId=${real}`,
    );
    const json: any = await res.json();
    console.log(`\n[HTTP] weekly-growth demo+userId=real → ${res.status} success=${json.success}`);
    if (json.success) console.log(fmtGrowth(json));
    else console.log("  error:", json.error);
  }

  // 3) weekly-cards snapshot 경로 (둘 다)
  for (const [label, uid] of [
    ["tester", tester],
    ["real", real],
  ] as const) {
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const json: any = await res.json();
    const cards: any[] = json.data ?? [];
    const newest = cards[0];
    const oldest = cards[cards.length - 1];
    console.log(
      `\n[HTTP] weekly-cards userId=${label} → ${res.status} success=${json.success} cards=${cards.length}`,
    );
    if (newest) {
      console.log(
        `  최신 카드: ${newest.weekLabel ?? newest.displayTitle} (${newest.startDate}~${newest.endDate}) seasonKey=${newest.seasonKey} status=${newest.userWeekStatus}/${newest.statusLabel}`,
      );
      console.log(
        `  최구 카드: ${oldest.weekLabel ?? oldest.displayTitle} (${oldest.startDate}~${oldest.endDate})`,
      );
    }
    if (json.error) console.log("  error:", json.error);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
