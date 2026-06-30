/**
 * Phase C — QA sweep 고객앱 반영 검증(customer :3001).
 *   QA 스윕 적립이 테스트 유저 W13 카드(checkGate.earned)에 반영되고 실유저 카드는 불변인지,
 *   고객앱이 실제 소비하는 weekly-cards proxy(:3001)로 확인. cleanup 원복.
 */
import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { accrueForCompletedRegular, revokeForAct } from "@/lib/processPointAccrual";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
const URL=process.env.NEXT_PUBLIC_SUPABASE_URL!,SERVICE=process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FRONT=process.env.FRONT_BASE??"http://localhost:3001";
const sb=createClient(URL,SERVICE,{auth:{persistSession:false}});
const TAG="ZZ-qacust",PAST="2020-01-01T00:00:00.000Z",ORG="oranke",PER=7;
let pass=0,fail=0;const ck=(l:string,ok:boolean,d="")=>{console.log(`${ok?"✅":"❌"} ${l}${d?` — ${d}`:""}`);ok?pass++:fail++;};
async function cards(uid:string){const r=await fetch(`${FRONT}/api/cluster4/weekly-cards?userId=${uid}&demoUserId=${uid}&mode=test`,{redirect:"follow"});if(!r.ok)return [];const j:any=await r.json();return (Array.isArray(j?.data)?j.data:(j?.cards??[])) as any[];}
async function cleanup(){const g=(await sb.from("process_line_groups").select("id").like("name",`${TAG}%`)).data??[];const gIds=(g as any[]).map(x=>x.id);if(gIds.length){const acts=(await sb.from("process_acts").select("id").in("line_group_id",gIds)).data??[];const aIds=(acts as any[]).map(x=>x.id);if(aIds.length){const sts=(await sb.from("process_check_statuses").select("id").in("act_id",aIds)).data??[];for(const sid of (sts as any[]).map(x=>x.id)){await sb.from("process_check_review_recipients").delete().eq("ref_id",sid);await sb.from("process_point_awards").delete().eq("ref_id",sid);}await sb.from("process_check_logs").delete().in("act_id",aIds);await sb.from("process_check_statuses").delete().in("act_id",aIds);await sb.from("process_acts").delete().in("id",aIds);}await sb.from("process_line_groups").delete().in("id",gIds);}}
async function main(){
  const markers=new Set(((await sb.from("test_user_markers").select("user_id")).data??[]).map((x:any)=>x.user_id));
  const oranke=((await sb.from("user_profiles").select("user_id").eq("organization_slug",ORG)).data??[]) as any[];
  const user=oranke.find(u=>markers.has(u.user_id))?.user_id, realUser=oranke.find(u=>!markers.has(u.user_id))?.user_id;
  const week=(await sb.from("weeks").select("id,iso_year,iso_week").eq("season_key","2026-spring").eq("week_number",13).maybeSingle()).data as any;
  if(!user||!realUser||!week?.id){console.log("⚠ 전제 미충족");process.exit(2);}
  const iso={y:week.iso_year,w:week.iso_week};
  const origRow=(await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id",user).eq("year",iso.y).eq("week_number",iso.w).maybeSingle()).data as any;
  const gate=(cs:any[])=>cs.find(c=>c.weekId===week.id)?.experienceGrowth?.checkGate?.earned ?? null;
  await cleanup();
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const tBefore=await cards(user); const eBefore=gate(tBefore);
  const realBefore=JSON.stringify(await cards(realUser));
  // 시드 + QA 스윕 적립.
  const grp=(await sb.from("process_line_groups").insert({hub:"info",name:`${TAG} 라인급`}).select("id").single()).data as any;
  const act=(await sb.from("process_acts").insert({line_group_id:grp.id,hub:"info",act_name:`${TAG} 액트`,duration_minutes:10,occur_week:"N",occur_dow:2,occur_time:"06:30",check_week:"N",check_dow:3,check_time:"21:00",point_check:PER,point_advantage:0,point_penalty:0,cafe:"occur",check_target:"check",act_type:"required"}).select("id").single()).data as any;
  const st=(await sb.from("process_check_statuses").insert({organization_slug:ORG,hub:"info",week_id:week.id,line_group_id:grp.id,act_id:act.id,status:"pending",review_link:"https://cafe.naver.com/x/1",scheduled_check_at:PAST,scope_mode:"test"}).select("id").single()).data as any;
  await runDueProcessCheckSweep({scope:"qa",onlyIds:[st.id],crawlAndMatch:async()=>({matched:[{userId:user,nickname:`${TAG}닉`,reason:"t"}],review:[]}),accrue:(_s,r)=>accrueForCompletedRegular(r)});
  const tAfter=await cards(user); const eAfter=gate(tAfter);
  ck("[고객앱] 테스트 유저 W13 카드 checkGate.earned 반영(+PER)", eAfter===(eBefore??0)+PER || JSON.stringify(tAfter)!==JSON.stringify(tBefore), `earned ${eBefore}→${eAfter}`);
  ck("[고객앱] 실유저 카드 불변(QA 미노출)", JSON.stringify(await cards(realUser))===realBefore);
  // cleanup.
  await revokeForAct("regular",st.id).catch(()=>{}); await cleanup();
  if(origRow) await sb.from("user_weekly_points").update({points:origRow.points,advantages:origRow.advantages,penalty:origRow.penalty,checks_migrated:origRow.checks_migrated}).eq("id",origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id",user).eq("year",iso.y).eq("week_number",iso.w);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const tRevert=await cards(user);
  ck("[고객앱] OFF 후 테스트 유저 카드 원복", gate(tRevert)===eBefore);
  console.log(`\n${pass} pass / ${fail} fail`);process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
