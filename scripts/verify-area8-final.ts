import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000"; const KEY = process.env.INTERNAL_API_KEY!;
const fmt = (segs:any[]) => (segs??[]).map((s:any)=>s.statusLabel).join(" → ");
async function getMap(uid:string, demo:boolean){
  const url = demo
    ? `${BASE}/api/cluster4/weekly-cards?userId=${uid}&demoUserId=${uid}`
    : `${BASE}/api/cluster4/weekly-cards?userId=${uid}`;
  const headers:any = demo ? { Referer: "http://localhost:3000/cluster-4-1-ec" } : { "x-internal-api-key": KEY };
  const j = await (await fetch(url,{headers})).json();
  return j.seasonActivityStatusesBySeason ?? {};
}
async function main(){
  // 1) 김은서(real) cross-season — 최신이 과거를 덮지 않음
  const kes="16e43a80-094b-48c8-86bc-5f84ea2e0eca";
  const m = await getMap(kes,false);
  console.log("[김은서] 시즌별 area-8 (HTTP internal):");
  for(const sk of Object.keys(m).sort()) console.log(`   ${sk}: ${fmt(m[sk])}`);
  // 2) demo == internal (test user T윤도현)
  const tyd="bf3b4305-751a-49e3-88ad-95a20e5c4dad";
  const di=await getMap(tyd,true), ii=await getMap(tyd,false);
  const eq=JSON.stringify(di)===JSON.stringify(ii);
  console.log(`\n[T윤도현] demo == internal area-8 맵: ${eq?"✅":"❌"} (demo seasons=${Object.keys(di).length}, internal=${Object.keys(ii).length})`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
