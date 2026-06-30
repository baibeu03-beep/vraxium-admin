import { pathToFileURL } from "url"; import { resolve } from "path";
import { createClient } from "@supabase/supabase-js"; import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
const BASE="http://localhost:3000";
const u=process.env.NEXT_PUBLIC_SUPABASE_URL!,a=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,s=process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed=0; const ck=(n:string,ok:boolean,d?:unknown)=>{console.log(`${ok?"✅":"❌"} ${n}${d!==undefined?" :: "+JSON.stringify(d):""}`);if(!ok)failed++;};
async function cookies_(){const {data:adm}=await supabaseAdmin.from("admin_users").select("email").eq("is_active",true).not("email","is",null).limit(1);const email=(adm?.[0] as any)?.email;const A=createClient(u,s),N=createClient(u,a);const {data:l}=await A.auth.admin.generateLink({type:"magiclink",email});const {data:v}=await N.auth.verifyOtp({email,token:(l as any).properties.email_otp,type:"magiclink"});const cap:any[]=[];const sv=createServerClient(u,a,{cookies:{getAll:()=>[],setAll:(it)=>cap.push(...it.map(({name,value}:any)=>({name,value})))}});await sv.auth.setSession({access_token:(v as any).session.access_token,refresh_token:(v as any).session.refresh_token});return cap.map((c:any)=>({name:c.name,value:c.value,domain:"localhost",path:"/"}));}
async function main(){
  const pw:any=await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium=pw.chromium??pw.default?.chromium;
  const ctx=await (await chromium.launch()).newContext({viewport:{width:1500,height:2200}}); await ctx.addCookies(await cookies_());
  async function open(qs:string){
    const page=await ctx.newPage(); const reqs:string[]=[]; let crash=false;
    page.on("request",(r:any)=>{const url=r.url(); if(url.includes("/api/admin/team-parts/info")) reqs.push(url.replace(BASE,""));});
    const resp=await page.goto(`${BASE}/admin/team-parts/info${qs}`,{waitUntil:"domcontentloaded",timeout:90000});
    await page.waitForTimeout(8000);
    const body=await page.evaluate(()=>document.body.innerText);
    crash=/Jest worker|child process exceptions|Internal Server Error/i.test(body);
    await page.close();
    return {status:resp?.status(),reqs:[...new Set(reqs)],crash};
  }
  const op=await open(""); console.log("operating reqs:",op.reqs.slice(0,2));
  ck("[브라우저] 운영 페이지 200·크래시 없음", op.status===200 && !op.crash, {status:op.status,crash:op.crash});
  const qa=await open("?mode=test"); console.log("qa reqs:",qa.reqs.slice(0,2));
  ck("[브라우저] QA 페이지 200·크래시 없음(Jest worker 0)", qa.status===200 && !qa.crash, {status:qa.status,crash:qa.crash});
  ck("[브라우저] QA 페이지 team-parts 요청에 mode=test 전파", qa.reqs.length>0 && qa.reqs.every(r=>r.includes("mode=test")), qa.reqs.slice(0,2));
  ck("[브라우저] 운영 페이지 요청에 mode=test 없음", op.reqs.length>0 && op.reqs.every(r=>!r.includes("mode=test")));
  await ctx.browser()?.close?.();
  console.log(failed===0?"\n✅ ALL PASS":`\n❌ ${failed} FAIL`); process.exit(failed?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
