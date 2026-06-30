import { pathToFileURL } from "url"; import { resolve } from "path";
import { createClient } from "@supabase/supabase-js"; import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
const BASE="http://localhost:3000";
const u=process.env.NEXT_PUBLIC_SUPABASE_URL!,a=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,s=process.env.SUPABASE_SERVICE_ROLE_KEY!;
async function ck(){const {data:adm}=await supabaseAdmin.from("admin_users").select("email").eq("is_active",true).not("email","is",null).limit(1);const email=(adm?.[0] as any)?.email;const A=createClient(u,s),N=createClient(u,a);const {data:l}=await A.auth.admin.generateLink({type:"magiclink",email});const {data:v}=await N.auth.verifyOtp({email,token:(l as any).properties.email_otp,type:"magiclink"});const cap:any[]=[];const sv=createServerClient(u,a,{cookies:{getAll:()=>[],setAll:(it)=>cap.push(...it.map(({name,value}:any)=>({name,value})))}});await sv.auth.setSession({access_token:(v as any).session.access_token,refresh_token:(v as any).session.refresh_token});return cap;}
async function main(){
  const pw:any=await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium=pw.chromium??pw.default?.chromium;
  const cookies=(await ck()).map((c:any)=>({name:c.name,value:c.value,domain:"localhost",path:"/"}));
  const b=await chromium.launch(); const ctx=await b.newContext(); await ctx.addCookies(cookies);
  const reqs:string[]=[]; const page=await ctx.newPage();
  page.on("request",(r:any)=>{const url=r.url(); if(url.includes("/api/admin/weekly-card-finalization")) reqs.push(url.replace(BASE,""));});
  await page.goto(`${BASE}/admin/weekly-card-finalization?mode=test`,{waitUntil:"domcontentloaded",timeout:90000});
  await page.waitForTimeout(8000);
  await b.close();
  console.log("finalization requests on ?mode=test:"); for(const r of [...new Set(reqs)]) console.log("  ",r.slice(0,90));
  const all=[...new Set(reqs)];
  const ok=all.length>0 && all.every(r=>r.includes("mode=test"));
  console.log(ok?"✅ 모든 finalization 요청에 mode=test 전파":"❌ 일부 요청에 mode=test 누락");
  process.exit(ok?0:1);
}
main().catch(e=>{console.error(e);process.exit(1)});
