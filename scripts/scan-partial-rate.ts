// 부분 강화율(0<num<den, den>=2) 카드를 가진 테스트 유저/주차를 찾는다 — 화면-DTO 동일성 검증용 샘플.
//   npx tsx --env-file=.env.local scripts/scan-partial-rate.ts
import { listTestUsers } from "@/lib/testUsers";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  const users = await listTestUsers();
  const hits: string[] = [];
  for (const u of users) {
    const snap = await readWeeklyCardsSnapshot(u.userId);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    for (const c of snap.cards) {
      const den = c.growthDenominator;
      const num = c.growthNumerator;
      if (den >= 2 && num > 0 && num < den) {
        hits.push(
          `${u.name} (${u.organizationSlug}) uid=${u.userId} | W#${c.weekNumber} weekId=${c.weekId} | ${num}/${den} = ${c.weeklyGrowthRate}% | status=${c.userWeekStatus}`,
        );
      }
    }
    if (hits.length >= 15) break;
  }
  // den=5 num=3(60%) 우선 노출
  hits.sort((a, b) => (a.includes("3/5") ? -1 : 0) - (b.includes("3/5") ? -1 : 0));
  console.log(hits.length ? hits.join("\n") : "no partial-rate card found");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
