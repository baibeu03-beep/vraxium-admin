/**
 * v25 카드 역할배지 전환 — position history 보유 사용자 snapshot 재계산.
 *   npx tsx --env-file=.env.local scripts/recompute-position-affected.ts
 *   position history 없는 사용자는 값 불변(현재값 fallback) → lazy/cron 자연 수렴.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main(){
  const ids = new Set<string>();
  for (let f=0;;f+=1000){
    const { data } = await sb.from("user_position_histories").select("user_id").order("user_id").range(f,f+999);
    const rows=(data??[]) as any[]; for(const r of rows) ids.add(r.user_id);
    if(rows.length<1000) break;
  }
  // only recompute those that already have a snapshot row (cron handles new users)
  const idList = [...ids];
  const present: string[] = [];
  for (let i=0;i<idList.length;i+=200){
    const chunk=idList.slice(i,i+200);
    const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id").in("user_id", chunk);
    for(const r of (data??[]) as any[]) present.push(r.user_id);
  }
  console.log(`position-history users=${ids.size}, with snapshot=${present.length} → recompute`);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(present, { concurrency: 4 });
  console.log("recompute result:", JSON.stringify(res));
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
