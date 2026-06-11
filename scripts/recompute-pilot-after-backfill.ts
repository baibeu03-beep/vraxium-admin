// 백필 후 재계산: recalcUserGrowthStats + recomputeAndStoreWeeklyCardsSnapshot (2명).
// 파생 테이블 재산출만 — rollback은 백필 rollback 후 본 스크립트 재실행으로 복귀.
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
async function main() {
  const PILOT = [
    { name: "권원중", uid: "361f69d5-a718-4675-bbcb-15b8f69bf431", expApproved: 29, expCumulative: 31 },
    { name: "권희윤", uid: "f7c159f8-ad78-46fd-b4c7-d39e6229f2e2", expApproved: 26, expCumulative: 27 },
  ];
  for (const p of PILOT) {
    const gs = await recalcUserGrowthStats(p.uid);
    const cards = await recomputeAndStoreWeeklyCardsSnapshot(p.uid);
    const okA = gs.approved_weeks === p.expApproved, okC = gs.cumulative_weeks === p.expCumulative;
    console.log(`✅ ${p.name}: approved ${gs.approved_weeks} ${okA ? "✅" : `✗(기대 ${p.expApproved})`} · cumulative ${gs.cumulative_weeks} ${okC ? "✅" : `✗(기대 ${p.expCumulative})`} · snapshot ${cards.length}카드`);
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
