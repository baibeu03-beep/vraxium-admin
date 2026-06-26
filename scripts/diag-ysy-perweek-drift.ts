import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
const UUID="73b3fa9a-e875-43d0-a945-477237eb2f68";
async function main(){
  // ledger agg by week_id (migration source)
  let led:any[]=[];for(let f=0;;f+=1000){const{data}=await sb.from("legacy_point_ledger").select("week_id,star,entry_type").eq("user_id",UUID).range(f,f+999);led.push(...(data??[]));if((data??[]).length<1000)break;}
  const ledByWeek=new Map<string,number>();
  for(const r of led){ if(r.entry_type==="POINTLOG_VOIDED")continue; ledByWeek.set(r.week_id,(ledByWeek.get(r.week_id)??0)+(r.star??0)); }
  // weeks map id->start
  let weeks:any[]=[];for(let f=0;;f+=1000){const{data}=await sb.from("weeks").select("id,start_date,season_key,week_number").range(f,f+999);weeks.push(...(data??[]));if((data??[]).length<1000)break;}
  const wById=new Map(weeks.map(w=>[w.id,w]));
  const ledByStart=new Map<string,number>();
  for(const [wid,s] of ledByWeek){ const w=wById.get(wid); if(w)ledByStart.set(w.start_date,(ledByStart.get(w.start_date)??0)+s); }
  // current uwp
  const {data:uwp}=await sb.from("user_weekly_points").select("week_start_date,points,advantages,penalty,checks_migrated,updated_at,created_at").eq("user_id",UUID).order("week_start_date").range(0,999);
  const rows=(uwp??[]) as any[];
  const allStarts=[...new Set([...ledByStart.keys(),...rows.map(r=>r.week_start_date)])].sort();
  let curSum=0, ledSum=0, driftSum=0;
  const drift:any[]=[];
  for(const s of allStarts){
    const cur=rows.find(r=>r.week_start_date===s);
    const curP=cur?.points??null; const ledP=ledByStart.get(s)??null;
    if(curP!=null)curSum+=curP; if(ledP!=null)ledSum+=ledP;
    const d=(curP??0)-(ledP??0);
    if(d!==0||curP==null||ledP==null){ driftSum+=d;
      const w=weeks.find(w=>w.start_date===s);
      drift.push({week:w?`${w.season_key} W${w.week_number}`:s, start:s, ledger_star:ledP, uwp_points:curP, drift:d, cm:cur?.checks_migrated, upd:(cur?.updated_at??"").slice(0,10)});
    }
  }
  console.log("현재 Σuwp.points =",curSum, "| Σledger.star(non-void) =",ledSum, "| Σdrift =",driftSum);
  console.log("\n주차별 drift(uwp.points ≠ ledger.star):");
  console.table(drift);
}
main().catch(e=>{console.error(e);process.exit(1);});
