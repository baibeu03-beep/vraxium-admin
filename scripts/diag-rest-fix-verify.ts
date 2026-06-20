/** diag-rest-fix-verify.ts (검증) — seasonal_rest 활동주차=휴식(개인) 정책 적용 확인 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { readFileSync } from "node:fs";
const KEY = readFileSync(".env.local","utf8").match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function http(id:string,mode?:string){
  const r=await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${id}${mode?`&mode=${mode}`:""}`,{headers:{"x-internal-api-key":KEY!}});
  const j=await r.json(); const cards=(j.data??[]) as any[];
  return {status:r.status,cards};
}
function bySeasonCount(cards:any[]){ const m:Record<string,number>={}; for(const c of cards) m[c.seasonKey??"(null)"]=(m[c.seasonKey??"(null)"]??0)+1; return m; }
function springDetail(cards:any[]){ return cards.filter(c=>c.seasonKey==="2026-spring").map(c=>`W${c.weekNumber}:${c.userWeekStatus}`).sort((a,b)=>{const na=+a.match(/\d+/)[0],nb=+b.match(/\d+/)[0];return na-nb;}); }
function snapCards(s:any){ return (s.status==="hit"||s.status==="stale")?(s.cards as any[]):[]; }

async function verify(name:string, prefix:string, allIds:string[]){
  const id=allIds.find(u=>u.startsWith(prefix)); if(!id){console.log(`${name} 못찾음`);return;}
  console.log(`\n${"=".repeat(70)}\n▶ ${name} ${id.slice(0,8)}`);
  // DB 원본
  const { data: ss } = await supabaseAdmin.from("user_season_statuses").select("season_key,status").eq("user_id",id);
  const { data: uws } = await supabaseAdmin.from("user_week_statuses").select("season_key").eq("user_id",id);
  console.log(`  DB: season_statuses=[${(ss??[]).map((r:any)=>`${r.season_key}:${r.status}`).join(", ")}] uws총=${uws?.length??0}`);

  // BEFORE (현재 저장된 snapshot — bump 으로 version_mismatch)
  const before = await readWeeklyCardsSnapshot(id);
  const bc = snapCards(before);
  console.log(`  BEFORE snapshot=${before.status}${(before as any).reason?`(${(before as any).reason})`:""} 총카드=${bc.length} bySeason=${JSON.stringify(bySeasonCount(bc))}`);
  console.log(`         2026-spring: [${springDetail(bc).join(" ")||"(없음)"}]`);

  // HTTP#1 → 서버측 재계산 트리거(version_mismatch bg)
  await http(id);
  await sleep(15000);

  // AFTER snapshot (재생성 결과)
  const after = await readWeeklyCardsSnapshot(id);
  const ac = snapCards(after);
  console.log(`  AFTER  snapshot=${after.status}${(after as any).reason?`(${(after as any).reason})`:""} 총카드=${ac.length} bySeason=${JSON.stringify(bySeasonCount(ac))}`);
  console.log(`         2026-spring: [${springDetail(ac).join(" ")||"(없음)"}]`);

  // HTTP (op + test) — direct(서버 빌더) == snapshot 확인
  const op=await http(id), test=await http(id,"test");
  const opSpring=springDetail(op.cards), snapSpring=springDetail(ac);
  console.log(`  HTTP(op) 총=${op.cards.length} 2026-spring=[${opSpring.join(" ")}]`);
  console.log(`  HTTP==snapshot? ${JSON.stringify(opSpring)===JSON.stringify(snapSpring)&&op.cards.length===ac.length} | op==test? ${op.cards.length===test.cards.length&&JSON.stringify(springDetail(test.cards))===JSON.stringify(opSpring)}`);
  return {before:bc, after:ac};
}

async function main(){
  const ids:string[]=[];
  for(let from=0;;from+=1000){ const {data}=await supabaseAdmin.from("user_profiles").select("user_id").range(from,from+999); if(!data||!data.length)break; ids.push(...data.map((r:any)=>r.user_id)); if(data.length<1000)break; }
  const hsa = await verify("황수아","ea05ce8d",ids);
  const yc  = await verify("윤채영","8eeb75ba",ids);

  console.log(`\n${"=".repeat(70)}\n[요약]`);
  if(hsa) console.log(`  황수아 카드: BEFORE ${hsa.before.length} → AFTER ${hsa.after.length}`);
  if(yc){
    const pastBefore = yc.before.filter(c=>c.seasonKey!=="2026-spring").length;
    const pastAfter  = yc.after.filter(c=>c.seasonKey!=="2026-spring").length;
    console.log(`  윤채영 카드: BEFORE ${yc.before.length} → AFTER ${yc.after.length}`);
    console.log(`  윤채영 과거(비2026-spring) 카드: BEFORE ${pastBefore} → AFTER ${pastAfter} (감소금지 충족=${pastAfter>=pastBefore})`);
    const b23 = bySeasonCount(yc.before)["2023-spring"]??0, a23 = bySeasonCount(yc.after)["2023-spring"]??0;
    console.log(`  윤채영 2023-spring 카드: BEFORE ${b23} → AFTER ${a23} (동일=${b23===a23})`);
  }
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
