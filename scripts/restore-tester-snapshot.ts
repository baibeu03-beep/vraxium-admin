// 시간여행 검증 후 테스터 snapshot 을 실제 시간 기준으로 복원 (단건 재계산·저장).
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const uid = process.argv[2] ?? "42864260-e4ea-4150-a87f-cff545b02af1";

async function main() {
  const cards = await recomputeAndStoreWeeklyCardsSnapshot(uid);
  console.log(`복원 완료: cards=${cards.length} 최신=${(cards[0] as any)?.weekLabel}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
