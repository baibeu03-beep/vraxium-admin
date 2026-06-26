import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const env = readFileSync(".env.local","utf8");
const get=(k)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"), {auth:{persistSession:false}});
const phase = process.argv[2]; // before | after
const OUT = "claudedocs/phalanx-crossorg-snap.json";
async function sampleOrg(org){
  const {data:profs}=await sb.from("user_profiles").select("user_id").eq("organization_slug",org).order("user_id").limit(20);
  const ids=(profs??[]).map(r=>r.user_id);
  const {data:snaps}=await sb.from("cluster4_weekly_card_snapshots").select("user_id,cards,is_stale").in("user_id",ids);
  const m={};
  for(const r of (snaps??[])) m[r.user_id]=JSON.stringify(r.cards);
  return m;
}
const oranke=await sampleOrg("oranke");
const encre=await sampleOrg("encre");
if(phase==="before"){
  writeFileSync(OUT,JSON.stringify({oranke,encre},null,0));
  console.log(`BEFORE 캡처: oranke ${Object.keys(oranke).length} · encre ${Object.keys(encre).length} snapshots`);
} else {
  const prev=JSON.parse(readFileSync(OUT,"utf8"));
  let changed=0,checked=0;
  for(const org of ["oranke","encre"]){
    const now=org==="oranke"?oranke:encre;
    for(const uid of Object.keys(prev[org])){ checked++; if(prev[org][uid]!==now[uid]) {changed++; console.log(`  ⚠ ${org} ${uid.slice(0,8)} 변경됨`);} }
  }
  console.log(`AFTER 비교: oranke+encre 표본 ${checked}명 중 변경 ${changed}명 (기대 0)`);
}
