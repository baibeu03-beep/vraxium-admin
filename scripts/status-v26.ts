import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;
async function main(){
  console.log("WEEKLY_CARDS_DTO_VERSION =", WEEKLY_CARDS_DTO_VERSION);
  // total snapshots + version distribution + is_stale
  let total=0, vCur=0, vOld=0, staleCnt=0;
  const oldVersions = new Map<number,number>();
  for (let f=0;;f+=1000){
    const { data } = await sb.from("cluster4_weekly_card_snapshots").select("dto_version,is_stale").order("user_id").range(f,f+999);
    const rows=(data??[]) as any[];
    for (const r of rows){ total++; if(r.dto_version===WEEKLY_CARDS_DTO_VERSION) vCur++; else { vOld++; oldVersions.set(r.dto_version,(oldVersions.get(r.dto_version)??0)+1);} if(r.is_stale) staleCnt++; }
    if(rows.length<1000) break;
  }
  console.log(`[4] 전체 snapshot=${total} | v${WEEKLY_CARDS_DTO_VERSION}=${vCur} | v26아님=${vOld} ${JSON.stringify([...oldVersions])}`);
  console.log(`[5] is_stale=true 잔여 = ${staleCnt}`);

  // 6/7/8: direct vs HTTP for a sample incl 김은서
  const sampleIds = ["16e43a80-094b-48c8-86bc-5f84ea2e0eca","003c703c-e0a0-419a-880b-1ecf36e3b3ca","16000b1f-30ad-4187-9754-11199a577a09"];
  for (const uid of sampleIds){
    const direct = await getCluster4WeeklyCardsForProfileUser(uid);
    const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`,{headers:{"x-internal-api-key":KEY}});
    const j = await r.json();
    const hMap = new Map((j.data??[]).map((c:any)=>[c.weekId,c.roleLabel]));
    let mism=0; for(const c of direct){ if(!c.weekId) continue; if(hMap.get(c.weekId)!==c.roleLabel) mism++; }
    console.log(`[6/7/8] ${uid.slice(0,8)} directCards=${direct.length} httpCards=${(j.data??[]).length} roleLabel 불일치=${mism} ${mism===0?"✅":"❌"}`);
  }

  // 9: demo path vs normal(internal) path same DTO — compare for a test user
  const testUid = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
  const demoR = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${testUid}&demoUserId=${testUid}`,{headers:{Referer:"http://localhost:3000/cluster-4-card-ec"}});
  const intR = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${testUid}`,{headers:{"x-internal-api-key":KEY}});
  const dj = await demoR.json(); const ij = await intR.json();
  const demoMap = new Map((dj.data??[]).map((c:any)=>[c.weekId,c.roleLabel]));
  const intMap = new Map((ij.data??[]).map((c:any)=>[c.weekId,c.roleLabel]));
  let dmism=0; for(const [k,v] of intMap){ if(demoMap.get(k)!==v) dmism++; }
  console.log(`[9] demo status=${demoR.status} count=${(dj.data??[]).length} | internal count=${(ij.data??[]).length} | roleLabel 불일치=${dmism} ${dmism===0&&demoR.status===200?"✅ 동일 DTO":"⚠"}`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
