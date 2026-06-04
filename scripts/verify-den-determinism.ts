/** 이슈1 검증: 분모A 페이지네이션 후 반복 재계산 den/num 동일성 (최다 주차 테스터) */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
const U = "42864260-e4ea-4150-a87f-cff545b02af1"; // T임다인 (분모A 매칭 2,765행 > cap 사례)
async function main() {
  const sigs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cards = await getCluster4WeeklyCardsForProfileUser(U);
    sigs.push(JSON.stringify(cards.map((c) => ({ w: c.startDate, d: c.growthDenominator, n: c.growthNumerator, s: c.userWeekStatus }))));
  }
  const same = sigs.every((s) => s === sigs[0]);
  console.log("3회 반복 den/num/status 동일성:", same ? "✓ 동일" : "✗ 불일치");
  if (!same) { console.log(sigs[0].slice(0, 400)); console.log(sigs[1].slice(0, 400)); }
  else console.log("sample:", sigs[0].slice(0, 300));
}
main();
