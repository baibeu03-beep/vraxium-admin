import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getWeekRecognitions, updateWeekRecognition, WeekRecognitionUpdateError } from "@/lib/adminWeekRecognitionsData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
const baseUrl="http://localhost:3000";
const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL!,anonKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY!;
let pass=0,fail=0; const ck=(l:string,ok:boolean,d="")=>{console.log(`${ok?"✅":"❌"} ${l}${d?` — ${d}`:""}`);ok?pass++:fail++;};
async function cookies_(){const {data:a}=await supabaseAdmin.from("admin_users").select("email").eq("is_active",true).not("email","is",null).limit(1);const email=(a?.[0] as any)?.email;const adm=createClient(supabaseUrl,serviceKey),an=createClient(supabaseUrl,anonKey);const {data:link}=await adm.auth.admin.generateLink({type:"magiclink",email});const {data:v}=await an.auth.verifyOtp({email,token:(link as any).properties.email_otp,type:"magiclink"});const cap:any[]=[];const sv=createServerClient(supabaseUrl,anonKey,{cookies:{getAll:()=>[],setAll:(it)=>cap.push(...it.map(({name,value}:any)=>({name,value})))}});await sv.auth.setSession({access_token:(v as any).session.access_token,refresh_token:(v as any).session.refresh_token});return cap;}
async function http(path:string,ck_:any[]){const r=await fetch(`${baseUrl}${path}`,{headers:{Cookie:ck_.map((c:any)=>`${c.name}=${c.value}`).join("; ")},cache:"no-store"});return (await r.json())?.data;}
function uids(dto:any):string[]{const rows=dto?.rows??dto?.recognitions??dto?.items??[];return [...new Set((rows as any[]).map(r=>r.userId??r.user_id).filter(Boolean))];}
async function main(){
  const testIds=await fetchTestUserMarkerIds();
  const split=(ids:string[])=>({total:ids.length,test:ids.filter(i=>testIds.has(i)).length,real:ids.filter(i=>!testIds.has(i)).length});
  // DIRECT scoped
  const dT=split(uids(await getWeekRecognitions({mode:"test"} as any)));
  const dO=split(uids(await getWeekRecognitions({mode:"operating"} as any)));
  ck("[direct mode=test] 실유저 0 · 테스트>0", dT.real===0 && dT.test>0, JSON.stringify(dT));
  ck("[direct operating] 테스트 0 · 실유저>0", dO.test===0 && dO.real>0, JSON.stringify(dO));
  // HTTP scoped
  const ck_=await cookies_();
  const hT=split(uids(await http("/api/admin/week-recognitions?mode=test",ck_)));
  const hO=split(uids(await http("/api/admin/week-recognitions",ck_)));
  ck("[HTTP mode=test] 실유저 0 · 테스트>0", hT.real===0 && hT.test>0, JSON.stringify(hT));
  ck("[HTTP operating] 테스트 0 · 실유저>0", hO.test===0 && hO.real>0, JSON.stringify(hO));
  ck("[direct==HTTP] test", JSON.stringify(dT)===JSON.stringify(hT));
  ck("[direct==HTTP] operating", JSON.stringify(dO)===JSON.stringify(hO));
  // WRITE GUARD (실사용자 write 차단) — read note, attempt wrong-mode update, assert 422 + unchanged.
  const realUws=(await supabaseAdmin.from("user_week_statuses").select("id,user_id,note").not("user_id","in",`(${[...testIds].join(",")})`).limit(1)).data?.[0] as any;
  const testUws=(await supabaseAdmin.from("user_week_statuses").select("id,user_id,note").in("user_id",[...testIds]).limit(1)).data?.[0] as any;
  async function guardTest(label:string,uws:any,mode:"operating"|"test",expectBlock:boolean){
    const before=(await supabaseAdmin.from("user_week_statuses").select("note").eq("id",uws.id).maybeSingle()).data as any;
    let threw=0; try{ await updateWeekRecognition(uws.id,{note:"__QA_GUARD_PROBE__"},mode);}catch(e){threw=(e as WeekRecognitionUpdateError)?.status??-1;}
    const after=(await supabaseAdmin.from("user_week_statuses").select("note").eq("id",uws.id).maybeSingle()).data as any;
    const unchanged=(before?.note??null)===(after?.note??null);
    if(expectBlock) ck(label,threw===422 && unchanged,`status=${threw} unchanged=${unchanged}`);
  }
  if(realUws) await guardTest("[write guard] 실유저 uws + mode=test → 422 차단·미변경",realUws,"test",true);
  if(testUws) await guardTest("[write guard] 테스트 uws + operating → 422 차단·미변경",testUws,"operating",true);
  console.log(`\n${pass} pass / ${fail} fail`); process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
