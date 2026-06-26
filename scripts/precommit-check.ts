import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main(){
  // 1+2) seed 잔여
  const { data: seed } = await sb.from("user_position_histories").select("id,user_id,source").eq("source","manual_test_seed");
  console.log(`[1/2] manual_test_seed 잔여행: ${(seed??[]).length} (T윤도현 포함 전체)`);
  const { data: tyd } = await sb.from("user_position_histories").select("id").eq("user_id","bf3b4305-751a-49e3-88ad-95a20e5c4dad").eq("source","manual_test_seed");
  console.log(`[2] T윤도현 seed 잔여: ${(tyd??[]).length}행`);
  // 3) snapshot 상태
  let total=0,vCur=0,stale=0; const old=new Map<number,number>();
  for(let f=0;;f+=1000){const{data}=await sb.from("cluster4_weekly_card_snapshots").select("dto_version,is_stale").order("user_id").range(f,f+999);
   const rows=(data??[]) as any[];for(const r of rows){total++;if(r.dto_version===WEEKLY_CARDS_DTO_VERSION)vCur++;else old.set(r.dto_version,(old.get(r.dto_version)??0)+1);if(r.is_stale)stale++;}if(rows.length<1000)break;}
  console.log(`[3] snapshot: total=${total} v${WEEKLY_CARDS_DTO_VERSION}=${vCur} 비v26=${total-vCur} ${JSON.stringify([...old])} is_stale=${stale}`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
