import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main(){
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,dto_version,computed_at").neq("dto_version", WEEKLY_CARDS_DTO_VERSION);
  console.log("비v26 사용자:", JSON.stringify((data??[]).map((r:any)=>({u:r.user_id.slice(0,8),v:r.dto_version,at:r.computed_at}))));
  for (const r of (data??[]) as any[]) { await recomputeAndStoreWeeklyCardsSnapshot(r.user_id); console.log("recomputed", r.user_id.slice(0,8)); }
  // re-check
  let total=0,vCur=0,stale=0;
  for(let f=0;;f+=1000){const{data:d}=await sb.from("cluster4_weekly_card_snapshots").select("dto_version,is_stale").order("user_id").range(f,f+999);
   const rows=(d??[]) as any[];for(const x of rows){total++;if(x.dto_version===WEEKLY_CARDS_DTO_VERSION)vCur++;if(x.is_stale)stale++;}if(rows.length<1000)break;}
  console.log(`재확인: total=${total} v26=${vCur} 비v26=${total-vCur} is_stale=${stale}`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
