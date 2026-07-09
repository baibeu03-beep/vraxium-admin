// 비파괴 측정: W1 코호트(85명) snapshot 재계산 concurrency 3 vs 8, growth 직렬 vs 병렬.
//   npx tsx --env-file=.env.local scripts/measure-recompute-concurrency.ts
//   idempotent — 동일 snapshot/growth 재저장(상태 변경 없음).
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recalcUserGrowthStats, recalcUserGrowthStatsForUsers } from "@/lib/userGrowthStatsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb.from("user_week_statuses").select("user_id").eq("week_start_date", "2026-06-29");
  const ids = Array.from(new Set((data ?? []).map((r: any) => r.user_id)));
  console.log(`코호트 = ${ids.length}명\n`);

  // snapshot: concurrency 3 (기존)
  let t = Date.now();
  const r3 = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 3 });
  const ms3 = Date.now() - t;
  console.log(`snapshot 재계산 concurrency=3 (기존): ${ms3}ms  (${(ms3 / ids.length).toFixed(0)}ms/명, ok=${r3.recomputed} fail=${r3.failed})`);

  // snapshot: concurrency 8 (개선)
  t = Date.now();
  const r8 = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 8 });
  const ms8 = Date.now() - t;
  console.log(`snapshot 재계산 concurrency=8 (개선): ${ms8}ms  (${(ms8 / ids.length).toFixed(0)}ms/명, ok=${r8.recomputed} fail=${r8.failed})`);
  console.log(`  → snapshot 개선율: ${(ms3 / ms8).toFixed(2)}x 빠름\n`);

  // growth: 직렬 for-await (기존)
  t = Date.now();
  for (const uid of ids) { try { await recalcUserGrowthStats(uid); } catch {} }
  const g1 = Date.now() - t;
  console.log(`growth 직렬 for-await (기존):    ${g1}ms`);

  // growth: 병렬 concurrency 8 (개선)
  t = Date.now();
  await recalcUserGrowthStatsForUsers(ids, { concurrency: 8 });
  const g8 = Date.now() - t;
  console.log(`growth 병렬 concurrency=8 (개선): ${g8}ms`);
  console.log(`  → growth 개선율: ${(g1 / g8).toFixed(2)}x 빠름\n`);

  console.log(`=== 실행 취소 사후 재계산 총합(추정) ===`);
  console.log(`  기존(snapshot c3 + growth 직렬):  ${((ms3 + g1) / 1000).toFixed(1)}s`);
  console.log(`  개선(snapshot c8 + growth 병렬):  ${((ms8 + g8) / 1000).toFixed(1)}s`);
  console.log(`  → 전체 개선율: ${((ms3 + g1) / (ms8 + g8)).toFixed(2)}x`);
  console.log("\n done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
