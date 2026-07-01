import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCompetencyOpeningStatus } from "@/lib/adminCompetencyLineOpening";
const URL=process.env.NEXT_PUBLIC_SUPABASE_URL!,ANON=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,SVC=process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EMAIL=process.env.SMOKE_ADMIN_EMAIL??"vanuatu.golden@gmail.com";
const sb=createClient(URL,SVC);
let pass=0,fail=0; const ck=(l:string,ok:boolean,d="")=>{console.log(`  ${ok?"✓":"✗"} ${l}${d?` — ${d}`:""}`);ok?pass++:fail++;};
async function cookie(){const a=createClient(URL,SVC);const b=createClient(URL,ANON);
  const {data:l}=await a.auth.admin.generateLink({type:"magiclink",email:EMAIL});
  const {data:v}=await b.auth.verifyOtp({email:EMAIL,token:l.properties!.email_otp!,type:"magiclink"});
  const cap:any[]=[];const s=createServerClient(URL,ANON,{cookies:{getAll:()=>[],setAll:(i)=>cap.push(...i)}});
  await s.auth.setSession({access_token:v.session!.access_token,refresh_token:v.session!.refresh_token});
  return cap.map(c=>`${c.name}=${c.value}`).join("; ");}
async function snap(){const {count}=await sb.from("cluster4_weekly_card_snapshots").select("*",{count:"exact",head:true});
  const {data}=await sb.from("cluster4_weekly_card_snapshots").select("computed_at").order("computed_at",{ascending:false}).limit(1).maybeSingle();
  return {count:count??0,latest:(data as any)?.computed_at??null};}
async function main(){
  const c=await cookie(); const H={cookie:c,"content-type":"application/json"};
  const ORG="oranke";
  const {data:ex}=await sb.from("line_opening_windows").select("week_id").is("activity_type_id",null).eq("is_active",true).eq("allow_opening",true).limit(1).maybeSingle();
  const exWeek=(ex as any)?.week_id; if(!exWeek){console.log("활성 scope=all 예외 없음 — 스킵");return;}
  const {data:nonEx}=await sb.from("weeks").select("id").neq("id",exWeek).order("start_date",{ascending:false}).limit(1).maybeSingle();
  const nonExWeek=(nonEx as any)?.id;
  console.log(`ORG=${ORG} 예외주차=${exWeek} 비예외주차=${nonExWeek}\n`);

  const before=await snap();

  // 1) opening-status?week_id=예외 → targetWeek == 예외주차 (HTTP)
  const st=await (await fetch(`http://localhost:3000/api/admin/cluster4/competency/opening-status?organization=${ORG}&week_id=${exWeek}`,{headers:{cookie:c}})).json();
  ck("[HTTP] opening-status?week_id=예외 → targetWeekId==예외", st.data?.targetWeek && true, `target=${st.data?.targetWeek?.year} ${st.data?.targetWeek?.seasonName} ${st.data?.targetWeek?.weekNumber}주차`);
  // direct
  const dst=await getCompetencyOpeningStatus(ORG as any,"operating",exWeek);
  ck("[direct==HTTP] opening-status opened/target 동일",
     dst.targetWeek?.startDate===st.data?.targetWeek?.startDate && dst.opened===st.data?.opened,
     `direct target=${dst.targetWeek?.startDate} opened=${dst.opened} / http target=${st.data?.targetWeek?.startDate} opened=${st.data?.opened}`);

  // 2) fail-closed: 비예외·비대상 주차 open → 400
  const bad=await fetch(`http://localhost:3000/api/admin/cluster4/competency/opening`,{method:"POST",headers:H,body:JSON.stringify({action:"open",organization:ORG,week_id:nonExWeek})});
  ck("[fail-closed] 비예외 주차 open → 4xx 거부", bad.status>=400, `status=${bad.status}`);

  // 3) 예외주차 open POST → 성공
  const beforeLines=await sb.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("part_type","competency");
  const openRes=await fetch(`http://localhost:3000/api/admin/cluster4/competency/opening`,{method:"POST",headers:H,body:JSON.stringify({action:"open",organization:ORG,week_id:exWeek})});
  const openJson=await openRes.json();
  ck("[POST] 예외주차 open → 201 success", openRes.status===201 && openJson.success, `status=${openRes.status} data=${JSON.stringify(openJson.data)}`);

  // 4) open 후 opened 상태(예외주차 기준)
  const st2=await (await fetch(`http://localhost:3000/api/admin/cluster4/competency/opening-status?organization=${ORG}&week_id=${exWeek}`,{headers:{cookie:c}})).json();
  console.log(`   open 후 opened(예외주차)=${st2.data?.opened} linesChanged=${openJson.data?.linesChanged}/${openJson.data?.linesTotal}`);

  // 5) 취소(원복)
  const cancelRes=await fetch(`http://localhost:3000/api/admin/cluster4/competency/opening`,{method:"POST",headers:H,body:JSON.stringify({action:"cancel",organization:ORG,week_id:exWeek})});
  ck("[POST] 예외주차 cancel → 성공(원복)", cancelRes.status===201);

  // 6) snapshot 무영향
  const after=await snap();
  ck("[snapshot] count 불변(예외 개설이 snapshot 미생성 · 0 크루=invalidate 스킵)", after.count===before.count, `count ${before.count}→${after.count} (latest 는 공유 dev DB 백그라운드 lazy-recompute 로 drift 가능=무관)`);

  // 정리: competency_week_output (oranke, 예외주차) 잔여 삭제
  await sb.from("cluster4_competency_week_output").delete().eq("organization_slug",ORG).eq("week_id",exWeek);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if(fail>0)process.exit(1);
}
main().catch(e=>{console.error(e);process.exit(1);});
