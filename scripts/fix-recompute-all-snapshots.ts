/** 모든 snapshot 유저 재계산 (파생 캐시 재생성, 멱등). W13 신규 라인 미반영 stale 해소용. */
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const ids = (data ?? []).map((r:any)=>r.user_id);
  console.log(`재계산 대상 유저: ${ids.length}명`);
  const t0 = Date.now();
  const res = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 5 });
  console.log(`완료 ${Date.now()-t0}ms`, JSON.stringify(res));
}
main().catch(e=>{console.error(e);process.exit(1);});
