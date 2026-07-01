import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadTeamPartsInfo, registerTeamHalf, TeamHalfWriteError } from "@/lib/adminTeamHalvesData";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { QA_FIXED_TEST_ONLY } from "@/lib/qaFixedScope";
const baseUrl="http://localhost:3000";
const u=process.env.NEXT_PUBLIC_SUPABASE_URL!,a=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,s=process.env.SUPABASE_SERVICE_ROLE_KEY!;
let pass=0,fail=0; const ck=(l:string,ok:boolean,d="")=>{console.log(`${ok?"✅":"❌"} ${l}${d?` — ${d}`:""}`);ok?pass++:fail++;};
async function ckie(){const {data:adm}=await supabaseAdmin.from("admin_users").select("email").eq("is_active",true).not("email","is",null).limit(1);const email=(adm?.[0] as any)?.email;const A=createClient(u,s),N=createClient(u,a);const {data:l}=await A.auth.admin.generateLink({type:"magiclink",email});const {data:v}=await N.auth.verifyOtp({email,token:(l as any).properties.email_otp,type:"magiclink"});const cap:any[]=[];const sv=createServerClient(u,a,{cookies:{getAll:()=>[],setAll:(it)=>cap.push(...it.map(({name,value}:any)=>({name,value})))}});await sv.auth.setSession({access_token:(v as any).session.access_token,refresh_token:(v as any).session.refresh_token});return cap.map((c:any)=>`${c.name}=${c.value}`).join("; ");}
async function http(path:string,cookie:string){const r=await fetch(`${baseUrl}${path}`,{headers:{Cookie:cookie},cache:"no-store"});return (await r.json())?.data;}
function names(dto:any):string[]{return ((dto?.teams??[]) as any[]).map(t=>t.teamName);}
async function main(){
  const ORG="oranke";
  const dT=await loadTeamPartsInfo(ORG,null,undefined,"test");
  const dO=await loadTeamPartsInfo(ORG,null,undefined,"operating");
  const tNames=names(dT), oNames=names(dO);
  // QA 고정 필터(QA_FIXED_TEST_ONLY): QA 중엔 operating 도 test 축 → 운영 팀 누수 0(빈 목록 허용:
  //   팀 반편성에 (T) 팀 미등록 가능). QA 종료 후 = (T) 팀 누수 0. 양쪽 다 "축 밖 팀 0 노출"로 검증.
  const opOk = (ns:string[]) => QA_FIXED_TEST_ONLY
    ? ns.filter(n=>!isTestTeam(ORG,n)).length===0
    : ns.filter(n=>isTestTeam(ORG,n)).length===0;
  ck("[direct test] 운영 팀 0 노출(누수 없음)", tNames.filter(n=>!isTestTeam(ORG,n)).length===0, `view=${tNames.length}`);
  ck(`[direct operating] ${QA_FIXED_TEST_ONLY?"운영 팀 0 노출(QA)":"(T) 테스트팀 0 노출"}`, opOk(oNames), `view=${oNames.length}`);
  const cookie=await ckie();
  const hT=names(await http(`/api/admin/team-parts/info?organization=${ORG}&mode=test`,cookie));
  const hO=names(await http(`/api/admin/team-parts/info?organization=${ORG}`,cookie));
  ck("[HTTP test] 운영 팀 0 노출", hT.filter(n=>!isTestTeam(ORG,n)).length===0, `view=${hT.length}`);
  ck(`[HTTP operating] ${QA_FIXED_TEST_ONLY?"운영 팀 0 노출(QA)":"(T) 0 노출"}`, opOk(hO), `view=${hO.length}`);
  ck("[direct==HTTP] test", JSON.stringify([...tNames].sort())===JSON.stringify([...hT].sort()));
  ck("[direct==HTTP] operating", JSON.stringify([...oNames].sort())===JSON.stringify([...hO].sort()));
  const beforeCount=(await supabaseAdmin.from("cluster4_team_halves").select("id",{count:"exact",head:true})).count??0;
  const cur=dO.currentHalfKey ?? dO.selectedHalfKey;
  async function guard(label:string,fn:()=>Promise<unknown>){let st=0;try{await fn();}catch(e){st=(e as TeamHalfWriteError)?.status??-1;}ck(label,st===422,`status=${st}`);}
  await guard("[write가드] test + 운영팀명 register → 422", ()=>registerTeamHalf({organization:ORG,halfKey:cur,teamName:"운영팀임시ZZ",description:"x",leaderCrewCode:"NONEXIST"},undefined,"test"));
  await guard("[write가드] operating + (T)팀명 register → 422", ()=>registerTeamHalf({organization:ORG,halfKey:cur,teamName:"과일(T)",description:"x",leaderCrewCode:"NONEXIST"},undefined,"operating"));
  const afterCount=(await supabaseAdmin.from("cluster4_team_halves").select("id",{count:"exact",head:true})).count??0;
  ck("[write가드] 거부 경로 DB 미변경", beforeCount===afterCount, `${beforeCount}→${afterCount}`);
  console.log(`\n${pass} pass / ${fail} fail`); process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
