/**
 * READ-ONLY: 시간 여행 — snapshot 생성 함수(getCluster4WeeklyCardsForProfileUser,
 * recomputeAndStoreWeeklyCardsSnapshot 이 호출하는 본체)가 주차 경계 후
 * 새 주차(15주차) 카드를 포함하는지 검증. DB 저장 없음.
 *
 *   npx tsx --env-file=.env.local scripts/diag-snapshot-gen-timetravel.ts <userId> [isoDateTime]
 */
const RealDate = Date;
const fakeIso = process.argv[3] ?? "2026-06-08T01:00:00Z"; // 6/8(월) 10:00 KST
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
  console.log(
    `가짜 현재 시각(UTC): ${new Date().toISOString()} (실제: ${new RealDate().toISOString()})`,
  );

  const { getCluster4WeeklyCardsForProfileUser } = await import(
    "@/lib/cluster4WeeklyCardsData"
  );
  const cards: any[] = await getCluster4WeeklyCardsForProfileUser(userId);
  console.log(`[snapshot-gen direct] cards=${cards.length}장 | 최신 3장:`);
  for (const c of cards.slice(0, 3)) {
    console.log(
      `  - ${c.weekLabel} (${c.startDate}~${c.endDate}) seasonKey=${c.seasonKey} status=${c.userWeekStatus}/${c.statusLabel}`,
    );
  }
  const w15 = cards.find(
    (c) => c.seasonKey === "2026-spring" && c.weekNumber === 15,
  );
  console.log(
    `\n15주차 카드 포함 여부: ${w15 ? `✅ 포함 (${w15.weekLabel}, status=${w15.userWeekStatus}/${w15.statusLabel})` : "❌ 없음"}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
