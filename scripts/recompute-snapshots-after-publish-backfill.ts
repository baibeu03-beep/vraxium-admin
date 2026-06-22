/**
 * weeks.result_published_at 백필(2023~2025) 이후 영향 사용자 weekly-cards snapshot 재계산.
 *   영향자 = 백필된 과거 주차(2026 미만)에 uws 가 있는 사용자.
 *   허브 카드(확정주차 success/fail)·이력서 activityCompletion(snapshot 직독) 정합 복구.
 *
 *   DRY_RUN=1 → 대상자 수만. 기본 → 재계산 write.
 *   npx tsx --env-file=.env.local scripts/recompute-snapshots-after-publish-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  // pre-2026 uws 보유 사용자 (백필 영향 superset).
  const affected = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id,week_start_date")
      .lt("week_start_date", "2026-01-01")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string; week_start_date: string }>;
    for (const r of rows) affected.add(r.user_id);
    if (rows.length < 1000) break;
  }
  const ids = [...affected];
  console.log(`영향 사용자(pre-2026 uws 보유): ${ids.length}`);

  if (DRY_RUN) { console.log("[DRY RUN] 재계산 생략."); return; }

  const t0 = Date.now();
  const res = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 4 });
  console.log(`재계산 완료: requested=${res.requested} recomputed=${res.recomputed} failed=${res.failed} (${Math.round((Date.now()-t0)/1000)}s)`);
  if (res.failed) console.log(`실패(stale 잔존, lazy/cron 보정): ${res.failedUserIds.slice(0,20).join(", ")}${res.failed>20?" ...":""}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
