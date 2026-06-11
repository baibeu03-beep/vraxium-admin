import { readFileSync } from "node:fs";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main(){
  const PILOT=[{name:"권원중",uid:"361f69d5-a718-4675-bbcb-15b8f69bf431"},{name:"권희윤",uid:"f7c159f8-ad78-46fd-b4c7-d39e6229f2e2"}];
  for(const p of PILOT){
    console.log(`\n■ ${p.name} (${p.uid.slice(0,8)})`);
    // 현재 상태
    const gsNow=(await supabaseAdmin.from("user_growth_stats").select("approved_weeks,cumulative_weeks").eq("user_id",p.uid)).data;
    const snapNow=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("card_count").eq("user_id",p.uid)).data;
    const ssNow=(await supabaseAdmin.from("user_season_statuses").select("season_key").eq("user_id",p.uid)).data;
    console.log(`  현재: growth_stats ${gsNow?.length?JSON.stringify(gsNow[0]):"없음"} · snapshot ${snapNow?.length?snapNow[0].card_count+"카드":"없음"} · season_statuses ${ssNow?.length??0}행`);
    // growth_stats would-be (recalc 로직 복제)
    const uws=(await supabaseAdmin.from("user_week_statuses").select("status,week_start_date").eq("user_id",p.uid)).data ?? [];
    let isTrans:(d:string)=>boolean; try{isTrans=(await import("@/lib/cluster4-transition-week")).isTransitionWeekStart as any;}catch{isTrans=()=>false;}
    const rows=uws.filter((r:any)=>!(r.week_start_date&&isTrans(r.week_start_date)));
    const cumulative=rows.length, approved=rows.filter((r:any)=>r.status==="success").length;
    console.log(`  → growth_stats 재계산: approved ${approved} / cumulative ${cumulative}`);
    // snapshot would-be (compute only, write 없음)
    const cards=await getCluster4WeeklyCardsForProfileUser(p.uid);
    const byStatus=cards.reduce((a:any,c:any)=>{const k=c.growthStatus??c.status??c.weekResult??"?";a[k]=(a[k]||0)+1;return a;},{});
    console.log(`  → snapshot 재계산(compute only): ${cards.length}카드, status분포 ${JSON.stringify(byStatus)}`);
    console.log(`  → user_season_statuses: 재계산 함수 대상 아님 → 변동 없음(현재 ${ssNow?.length??0}행 유지)`);
  }
  console.log("\n[write 없음 — getCluster4WeeklyCardsForProfileUser는 read-only compute, upsert 미호출]");
}
main().catch(e=>{console.error(e);process.exit(1);});
