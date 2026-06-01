/**
 * 주차 카드 snapshot 백필.
 *
 * cluster4_weekly_card_snapshots 테이블을 사용자별로 채운다(없으면 생성, 있으면 갱신).
 * 계산은 기존 실시간 함수(getCluster4WeeklyCardsForProfileUser)를 재사용한다.
 *
 * 사용:
 *   # 전체 사용자 백필
 *   npx tsx --env-file=.env.local scripts/backfill-weekly-card-snapshots.ts
 *   # 특정 사용자만
 *   npx tsx --env-file=.env.local scripts/backfill-weekly-card-snapshots.ts <profileUserId>
 *
 * npm:  npm run backfill:weekly-card-snapshots
 */
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const CONCURRENCY = 3; // 각 재계산이 ~37쿼리이므로 동시성은 낮게(부하 보호).

async function listProfileUserIds(): Promise<string[]> {
  // user_profiles 전체. (활동 없는 유저는 빈 카드 배열이 저장되며, 읽기 1쿼리로 빠르게 응답된다.)
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_profiles")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { user_id: string }[];
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

async function run() {
  const single = process.argv[2]?.trim();
  const userIds = single ? [single] : await listProfileUserIds();
  console.log(`[backfill] target users = ${userIds.length}${single ? " (single)" : ""}`);

  let done = 0;
  let ok = 0;
  let failed = 0;
  const t0 = Date.now();

  // 간단한 동시성 풀.
  let cursor = 0;
  async function worker(workerId: number) {
    while (cursor < userIds.length) {
      const i = cursor++;
      const uid = userIds[i];
      try {
        const cards = await recomputeAndStoreWeeklyCardsSnapshot(uid);
        ok++;
        if ((done + 1) % 25 === 0 || single) {
          console.log(`[backfill][w${workerId}] ${uid} → ${cards.length} cards`);
        }
      } catch (e) {
        failed++;
        console.warn(`[backfill][w${workerId}] FAILED ${uid}:`, e instanceof Error ? e.message : e);
      } finally {
        done++;
        if (done % 100 === 0) {
          console.log(`[backfill] progress ${done}/${userIds.length} (ok=${ok}, failed=${failed})`);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, userIds.length) }, (_, w) => worker(w)),
  );

  console.log(
    `[backfill] DONE in ${Math.round((Date.now() - t0) / 1000)}s — ok=${ok}, failed=${failed}, total=${userIds.length}`,
  );
}

run().catch((e) => {
  console.error("[backfill] fatal", e);
  process.exit(1);
});
