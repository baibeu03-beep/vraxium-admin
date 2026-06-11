import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function wl(o:string){const r=await fetch(`https://vraxium.vercel.app/api/weekly-league?org=${o}`,{redirect:"follow"});const j=await r.json();const b:any={};for(const c of j.cards)b[c.weekNumber]=[c.totalCrews,c.growthSuccess,c.growthFail,c.personalRest];return b;}
async function main(){
  const uids=["361f69d5-a718-4675-bbcb-15b8f69bf431","f7c159f8-ad78-46fd-b4c7-d39e6229f2e2"];
  // 6) growth_status
  const prof=(await supabaseAdmin.from("user_profiles").select("display_name,growth_status,status").in("user_id",uids)).data;
  console.log("6) growth_status:",JSON.stringify(prof));
  // 3·8) snapshot direct (저장된 카드 status 분포)
  const snap=(await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,card_count,cards").in("user_id",uids)).data ?? [];
  for(const s of snap){const dist=(s.cards as any[]).reduce((a:any,c:any)=>{const k=c.status??c.weekResult??c.cardStatus??"?";a[k]=(a[k]||0)+1;return a;},{});console.log(`3·8) snapshot ${s.user_id.slice(0,8)}: ${s.card_count}카드 status=${JSON.stringify(dist)}`);}
  // 7) weekly-ranking 불변
  const p=await wl("phalanx"),e=await wl("encre"),o=await wl("oranke");
  console.log(`7) phalanx W13 ${p[13].join("/")} ${p[13].join("/")==="31/28/2/1"?"✅":"✗"} · W12 ${p[12].join("/")} ${p[12].join("/")==="31/29/1/1"?"✅":"✗"}`);
  console.log(`   encre W13 ${e[13].join("/")} ${e[13].join("/")==="133/99/16/18"?"✅":"✗"} · oranke W13 ${o[13].join("/")} ${o[13].join("/")==="82/66/9/7"?"✅":"✗"}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
