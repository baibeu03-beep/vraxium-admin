/** diag-encre-rest-cumulative.ts (READ-ONLY) — pure-select, builder/snapshot 미사용 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(80));
const ACTIVITY_STARTS = ["2026-03-02","2026-03-09","2026-03-16","2026-03-23","2026-03-30","2026-04-27","2026-05-04","2026-05-11","2026-05-18","2026-05-25"];
const SPRING_STARTS = [...ACTIVITY_STARTS,"2026-04-06","2026-04-13","2026-04-20","2026-06-01","2026-06-08","2026-06-15"];

async function deep(uid: string, label: string, prof: any) {
  hr();
  line(`▶ ${label} ${uid.slice(0,8)} name=${prof?.display_name} org=${prof?.organization_slug} growth=${prof?.growth_status}`);
  const { data: ss } = await supabaseAdmin.from("user_season_statuses").select("season_key,status").eq("user_id", uid);
  line(`   season_statuses=[${(ss??[]).map((r:any)=>`${r.season_key}:${r.status}`).join(", ")}]`);
  const { data: uws } = await supabaseAdmin.from("user_week_statuses").select("week_start_date,status,season_key").eq("user_id", uid);
  const bySeason: Record<string,number> = {}; const springRows: string[] = [];
  for (const r of (uws??[]) as any[]) { bySeason[r.season_key??"?"]=(bySeason[r.season_key??"?"]??0)+1; if (SPRING_STARTS.includes(r.week_start_date)) springRows.push(`${r.week_start_date}:${r.status}`); }
  const springAct = ACTIVITY_STARTS.filter(s=>(uws??[]).some((r:any)=>r.week_start_date===s)).length;
  line(`   uws 총=${uws?.length??0} 시즌별=${JSON.stringify(bySeason)} | 2026-spring 활동주차커버=${springAct}/10`);
  line(`   uws 2026-spring rows: ${springRows.sort().join(" ")||"(없음)"}`);
  const { data: gst } = await supabaseAdmin.from("user_growth_stats").select("cumulative_weeks,approved_weeks").eq("user_id", uid).maybeSingle();
  line(`   [캐시] user_growth_stats.cumulative_weeks=${(gst as any)?.cumulative_weeks??"(행없음)"} approved_weeks=${(gst as any)?.approved_weeks??"-"}`);
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,growth_status,organization_slug");
  const all = (profs??[]) as any[];
  const byId = new Map(all.map(p=>[p.user_id,p]));

  const hsa = all.find(p=>p.user_id.startsWith("ea05ce8d"));
  const yc = all.find(p=>p.user_id.startsWith("8eeb75ba"));
  if (hsa) await deep(hsa.user_id, "황수아", hsa);
  if (yc) await deep(yc.user_id, "윤채영", yc);

  // encre 코호트
  hr(); line("=== encre 코호트(운영): 2026-spring 활동커버 + 캐시누적 ===");
  const ops = all.filter(p=>p.organization_slug==="encre" && !testIds.has(p.user_id));
  const ids = ops.map(p=>p.user_id);
  const act = new Map<string,number>(); const tot = new Map<string,number>();
  for (let i=0;i<ids.length;i+=80){ const c=ids.slice(i,i+80);
    const { data } = await supabaseAdmin.from("user_week_statuses").select("user_id,week_start_date").in("user_id",c);
    for (const r of (data??[]) as any[]){ tot.set(r.user_id,(tot.get(r.user_id)??0)+1); if(ACTIVITY_STARTS.includes(r.week_start_date)) act.set(r.user_id,(act.get(r.user_id)??0)+1);} }
  const cum = new Map<string,number|null>();
  for (let i=0;i<ids.length;i+=80){ const c=ids.slice(i,i+80);
    const { data } = await supabaseAdmin.from("user_growth_stats").select("user_id,cumulative_weeks").in("user_id",c);
    for (const r of (data??[]) as any[]) cum.set(r.user_id,r.cumulative_weeks); }
  const stat=(list:any[])=>{ const covs=list.map(p=>act.get(p.user_id)??0); const avg=covs.length?covs.reduce((a,b)=>a+b,0)/covs.length:0;
    return {n:list.length,avg:avg.toFixed(1),a0:list.filter(p=>(act.get(p.user_id)??0)===0).length,a5:list.filter(p=>(act.get(p.user_id)??0)>=5).length,a10:list.filter(p=>(act.get(p.user_id)??0)===10).length,c0:list.filter(p=>(cum.get(p.user_id)??0)===0).length};};
  const r=stat(ops.filter(p=>p.growth_status==="seasonal_rest")), n=stat(ops.filter(p=>p.growth_status!=="seasonal_rest"));
  line(`  seasonal_rest : n=${r.n} 평균활동커버=${r.avg}/10 활동0=${r.a0} 활동>=5=${r.a5} 활동10=${r.a10} 캐시누적0=${r.c0}`);
  line(`  비휴식        : n=${n.n} 평균활동커버=${n.avg}/10 활동0=${n.a0} 활동>=5=${n.a5} 활동10=${n.a10} 캐시누적0=${n.c0}`);
  hr(); line("DONE");
}
main().then(()=>process.exit(0),(e)=>{console.error("FATAL",e);process.exit(1);});
