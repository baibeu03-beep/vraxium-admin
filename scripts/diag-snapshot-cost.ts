/**
 * snapshot 생성/조회 비용 측정.
 *
 *   npx tsx --env-file=.env.local scripts/diag-snapshot-cost.ts <heavyUserId> <lightUserId>
 *
 *   1) 단건 생성(계산만, 저장 없음): getCluster4WeeklyCardsForProfileUser ×3회
 *   2) 단건 생성(계산+저장): recomputeAndStoreWeeklyCardsSnapshot ×1회 (멱등 upsert)
 *   3) snapshot read: readWeeklyCardsSnapshot ×5회 (조회 API stale 검사 경로 그대로)
 */
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const heavy = process.argv[2]!;
const light = process.argv[3]!;

async function timeIt<T>(label: string, n: number, fn: () => Promise<T>) {
  const times: number[] = [];
  let last: any;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    last = await fn();
    times.push(Date.now() - t0);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`${label}: ${times.join("ms, ")}ms | 평균 ${avg}ms`);
  return last;
}

async function main() {
  for (const [tag, uid] of [
    ["HEAVY(39카드 테스터)", heavy],
    ["LIGHT(5카드 실유저)", light],
  ] as const) {
    console.log(`\n===== ${tag} ${uid.slice(0, 8)} =====`);
    const cards: any[] = await timeIt("  생성(계산만) ×3", 3, () =>
      getCluster4WeeklyCardsForProfileUser(uid),
    );
    console.log(`  → cards=${cards.length}장`);
    await timeIt("  생성+저장 ×1", 1, () =>
      recomputeAndStoreWeeklyCardsSnapshot(uid),
    );
    await timeIt("  snapshot read ×5", 5, () => readWeeklyCardsSnapshot(uid));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
