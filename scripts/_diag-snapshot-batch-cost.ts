// 진단(일회성): weekly-card snapshot 재계산의 코호트 규모별 비용 곡선.
//   라인 개설/취소가 요청 안에서 recompute 를 몇 명까지 감당할 수 있는지 판단하기 위한 실측.
//   (재계산은 멱등 — 같은 입력에서 같은 카드가 다시 저장된다. 데이터 변경 없음.)
//   npx tsx --env-file=.env.local scripts/_diag-snapshot-batch-cost.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  recomputeWeeklyCardsSnapshotsForUsers,
  markWeeklyCardsSnapshotStaleMany,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

async function main() {
  const testIds = Array.from(await fetchTestUserMarkerIds());
  const { data: snaps } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .in("user_id", testIds.slice(0, 100));
  const pool = ((snaps ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  console.log("테스트 유저 snapshot 보유:", pool.length);

  console.log("\n=== markStale 비용 ===");
  for (const n of [12, 91, 200]) {
    const ids = pool.slice(0, Math.min(n, pool.length));
    if (ids.length === 0) continue;
    const t = Date.now();
    await markWeeklyCardsSnapshotStaleMany(ids);
    console.log(`  markStaleMany(${ids.length}) : ${Date.now() - t}ms`);
  }

  console.log("\n=== recompute 비용 (코호트 요청 캐시 적용) ===");
  for (const [n, conc] of [
    [1, 3],
    [3, 3],
    [5, 3],
    [10, 3],
    [10, 8],
    [20, 8],
  ] as const) {
    const ids = pool.slice(0, n);
    if (ids.length < n) {
      console.log(`  n=${n}: 풀 부족(${pool.length}) — 스킵`);
      continue;
    }
    const t = Date.now();
    const r = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: conc });
    const ms = Date.now() - t;
    console.log(
      `  n=${n} conc=${conc} : ${ms}ms  (${Math.round(ms / n)}ms/user, recomputed=${r.recomputed} failed=${r.failed})`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
