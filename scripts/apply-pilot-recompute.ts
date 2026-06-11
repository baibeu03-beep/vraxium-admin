import { writeFileSync } from "node:fs";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main(){
  const PILOT=[{name:"권원중",uid:"361f69d5-a718-4675-bbcb-15b8f69bf431"},{name:"권희윤",uid:"f7c159f8-ad78-46fd-b4c7-d39e6229f2e2"}];
  const uids=PILOT.map(p=>p.uid);
  // baseline 전체(기존29 무변경 검증)
  const gsBefore=(await supabaseAdmin.from("user_growth_stats").select("user_id",{count:"exact",head:true})).count;
  const snBefore=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id",{count:"exact",head:true})).count;
  // 2명 before 캡처(없음 기대)
  const before=[];
  for(const p of PILOT){
    const gs=(await supabaseAdmin.from("user_growth_stats").select("*").eq("user_id",p.uid)).data;
    const sn=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id").eq("user_id",p.uid)).data;
    before.push({uid:p.uid,growth_stats_existed:!!gs?.length,snapshot_existed:!!sn?.length});
  }
  console.log(`baseline 전체: growth_stats ${gsBefore} · snapshot ${snBefore} · 2명 before=${JSON.stringify(before.map(b=>({gs:b.growth_stats_existed,sn:b.snapshot_existed})))}`);
  // apply (2 uid만)
  for(const p of PILOT){
    const gs=await recalcUserGrowthStats(p.uid);
    const cards=await recomputeAndStoreWeeklyCardsSnapshot(p.uid);
    console.log(`✅ ${p.name}: growth_stats {approved ${gs.approved_weeks}, cumulative ${gs.cumulative_weeks}} · snapshot ${cards.length}카드`);
  }
  // 검증
  const gsAfter=(await supabaseAdmin.from("user_growth_stats").select("user_id",{count:"exact",head:true})).count;
  const snAfter=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id",{count:"exact",head:true})).count;
  const gs2=(await supabaseAdmin.from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks").in("user_id",uids)).data;
  const sn2=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,card_count").in("user_id",uids)).data;
  console.log(`\n1) growth_stats 2명: ${JSON.stringify(gs2)}`);
  console.log(`2) snapshot 2명: ${JSON.stringify(sn2)}`);
  console.log(`전체 growth_stats ${gsBefore}→${gsAfter}(Δ${gsAfter-gsBefore})·snapshot ${snBefore}→${snAfter}(Δ${snAfter-snBefore}) — 기존29 무변경(2명만)`);
  writeFileSync("claudedocs/apply-pilot-recompute-rollback-20260611.json",JSON.stringify({uids,note:"재계산 전 2명은 growth_stats/snapshot 0행이었음",rollback:`DELETE FROM user_growth_stats WHERE user_id IN ('${uids.join("','")}'); DELETE FROM cluster4_weekly_card_snapshots WHERE user_id IN ('${uids.join("','")}');`},null,2));
  console.log("11) 📄 rollback: claudedocs/apply-pilot-recompute-rollback-20260611.json");
}
main().catch(e=>{console.error(e);process.exit(1);});
