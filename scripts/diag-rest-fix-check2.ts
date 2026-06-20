/** 누적 성장주차 미포함(정책6) + 테스트 휴식회원 카드 검증 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { readFileSync } from "node:fs";
const KEY = readFileSync(".env.local","utf8").match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function http(id:string,mode?:string){ const r=await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${id}${mode?`&mode=${mode}`:""}`,{headers:{"x-internal-api-key":KEY!}}); const j=await r.json(); return (j.data??[]) as any[]; }
const spring=(c:any[])=>c.filter(x=>x.seasonKey==="2026-spring").sort((a,b)=>a.weekNumber-b.weekNumber).map(x=>`W${x.weekNumber}:${x.userWeekStatus}`);
async function main(){
  const ids:string[]=[]; for(let f=0;;f+=1000){const{data}=await supabaseAdmin.from("user_profiles").select("user_id").range(f,f+999); if(!data||!data.length)break; ids.push(...data.map((r:any)=>r.user_id)); if(data.length<1000)break;}
  // 정책6: 황수아/윤채영 현재시즌 personal_rest 카드의 accumulatedApprovedWeeks 가 증가하지 않는가
  for(const [name,p] of [["황수아","ea05ce8d"],["윤채영","8eeb75ba"]] as any[]){
    const id=ids.find(u=>u.startsWith(p)); if(!id)continue;
    const s=await readWeeklyCardsSnapshot(id); const cards=(s.status==="hit"||s.status==="stale")?(s.cards as any[]):[];
    const spr=cards.filter(c=>c.seasonKey==="2026-spring").sort((a,b)=>a.weekNumber-b.weekNumber);
    const accs=spr.map(c=>`W${c.weekNumber}:${c.userWeekStatus}=acc${c.accumulatedApprovedWeeks}`);
    const maxAcc=Math.max(0,...cards.map(c=>c.accumulatedApprovedWeeks??0));
    console.log(`\n${name}: 전체 최대누적성장주차=${maxAcc}`);
    console.log(`  현재시즌 카드 누적값: ${accs.join("  ")}`);
  }
  // 테스트 휴식회원(데모 가능) — 활동주차 success/fail 이 personal_rest 로 전환되는지(정책2)
  const { data: t } = await supabaseAdmin.from("user_profiles").select("user_id,display_name").eq("display_name","T송하린").maybeSingle();
  if(t){ const id=(t as any).user_id;
    await http(id); await sleep(15000); // version_mismatch bg 재계산
    const op=await http(id), test=await http(id,"test");
    console.log(`\nT송하린 ${id.slice(0,8)} (테스트 휴식회원)`);
    console.log(`  HTTP(op)  2026-spring=[${spring(op).join(" ")}]`);
    console.log(`  op==test? ${op.length===test.length&&JSON.stringify(spring(op))===JSON.stringify(spring(test))}`);
  }
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
