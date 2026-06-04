/**
 * READ-ONLY: 시간 여행 검증 — Date 를 2026-06-08(월, 주차 경계 직후)로 패치한 뒤
 * getWeeklyGrowth(live) 가 15주차로 자동 전환되는지 direct 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-week-transition-timetravel.ts <userId> [isoDateTime]
 */
const RealDate = Date;
const fakeIso = process.argv[3] ?? "2026-06-08T01:00:00Z"; // 6/8 10:00 KST (월요일 오전)
const FAKE_NOW = new RealDate(fakeIso).getTime();

class FakeDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FAKE_NOW);
    else super(...(args as [any]));
  }
  static now() {
    return FAKE_NOW;
  }
}
(globalThis as any).Date = FakeDate;

async function main() {
  const userId = process.argv[2]!;
  console.log(`가짜 현재 시각(UTC): ${new Date().toISOString()} (실제: ${new RealDate().toISOString()})`);

  const { getWeeklyGrowth } = await import("@/lib/cluster4WeeklyGrowthData");
  const dto = await getWeeklyGrowth(userId);
  if (!dto) {
    console.log("getWeeklyGrowth → null");
    return;
  }
  const cw = dto.currentWeekInfo;
  console.log(
    `[time-travel direct] currentWeekInfo: ${cw.year} ${cw.seasonName} ${cw.weekNumber}주차 (${cw.startDate}~${cw.endDate}) status=${cw.status}`,
  );
  const g = dto.growthSummary;
  console.log(
    `[time-travel direct] growthSummary: available=${g.availableWeeks} approved=${g.approvedWeeks} failed=${g.failedWeeks} rest=${g.restWeeks} endStatus=${g.endStatus}`,
  );
  const ss: any = dto.seasonSummary;
  console.log(`[time-travel direct] seasonSummary: ${ss?.displayTitle} status=${ss?.status}(${ss?.statusLabel})`);
  const cards: any[] = dto.weeklyCards ?? [];
  console.log(`[time-travel direct] weeklyCards: ${cards.length}장 | 최신 3장:`);
  for (const c of cards.slice(0, 3)) {
    console.log(
      `  - w${c.weekNumber} (${c.weekStartDate ?? c.startDate ?? "?"}) resultStatus=${c.resultStatus} label=${c.resultLabel ?? "-"}`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
