/** practical-info?mode=test 실제 호출 전수 캡처 — 어떤 /api/admin/* 가 운영 실유저를 반환하는지 식별. */
import { pathToFileURL } from "url"; import { resolve } from "path";
import { createClient } from "@supabase/supabase-js"; import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
const BASE="http://localhost:3000";
const u=process.env.NEXT_PUBLIC_SUPABASE_URL!,a=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,s=process.env.SUPABASE_SERVICE_ROLE_KEY!;
async function cookies_(){const {data:adm}=await supabaseAdmin.from("admin_users").select("email").eq("is_active",true).not("email","is",null).limit(1);const email=(adm?.[0] as any)?.email;const A=createClient(u,s),N=createClient(u,a);const {data:l}=await A.auth.admin.generateLink({type:"magiclink",email});const {data:v}=await N.auth.verifyOtp({email,token:(l as any).properties.email_otp,type:"magiclink"});const cap:any[]=[];const sv=createServerClient(u,a,{cookies:{getAll:()=>[],setAll:(it)=>cap.push(...it.map(({name,value}:any)=>({name,value})))}});await sv.auth.setSession({access_token:(v as any).session.access_token,refresh_token:(v as any).session.refresh_token});return cap.map((c:any)=>({name:c.name,value:c.value,domain:"localhost",path:"/"}));}
// 응답 JSON 안의 모든 uuid 형태 user_id/userId/target_user_id 추출(깊이 탐색).
function deepUserIds(o:any,acc:Set<string>){if(!o||typeof o!=="object")return;for(const[k,val]of Object.entries(o)){if((/user_?id$/i.test(k)||k==="target_user_id"||k==="targetUserId")&&typeof val==="string"&&/^[0-9a-f-]{36}$/i.test(val))acc.add(val);else if(val&&typeof val==="object")deepUserIds(val,acc);}}
async function main(){
  const markers=new Set(((await supabaseAdmin.from("test_user_markers").select("user_id")).data??[]).map((x:any)=>x.user_id));
  const pw:any=await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium=pw.chromium??pw.default?.chromium;
  const browser=await chromium.launch(); const ctx=await browser.newContext({viewport:{width:1500,height:2600}}); await ctx.addCookies(await cookies_());
  const page=await ctx.newPage();
  const byUrl=new Map<string,{ids:Set<string>,hadMode:boolean,status:number}>();
  page.on("response",async(r:any)=>{const url=r.url(); if(!/\/api\/admin\//.test(url))return; const short=url.replace(BASE,"").split("#")[0];
    try{const j=await r.json(); const ids=new Set<string>(); deepUserIds(j,ids); const ex=byUrl.get(short)??{ids:new Set(),hadMode:/[?&]mode=test/.test(url),status:r.status()}; ids.forEach(i=>ex.ids.add(i)); ex.hadMode=ex.hadMode||/[?&]mode=test/.test(url); byUrl.set(short,ex);}catch{}});
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre&mode=test`,{waitUntil:"domcontentloaded",timeout:90000});
  await page.waitForTimeout(11000);
  await ctx.close(); await browser.close();
  console.log("URL (mode=test 페이지 로드 시 호출된 /api/admin/*):\n");
  for(const[url,info]of [...byUrl.entries()].sort()){
    const op=[...info.ids].filter(i=>!markers.has(i)); const tu=[...info.ids].filter(i=>markers.has(i));
    const flag=op.length>0?"  ❌ 운영유저 노출":"";
    console.log(`${flag?"❌":"  "} ${url}`);
    console.log(`      ids=${info.ids.size} 운영=${op.length} 테스트=${tu.length} url에mode=test:${info.hadMode}${flag}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
