/** 비휴식 회귀 검증: 내 변경이 비휴식 회원 카드를 바꾸지 않는지(버전 bump 후 재계산 포함) */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { readFileSync } from "node:fs";
const KEY=readFileSync(".env.local","utf8").match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function http(id:string,mode?:string){const r=await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${id}${mode?`&mode=${mode}`:""}`,{headers:{"x-internal-api-key":KEY!}});const j=await r.json();return (j.data??[]) as any[];}
const spring=(c:any[])=>c.filter(x=>x.seasonKey==="2026-spring").sort((a,b)=>a.weekNumber-b.weekNumber).map(x=>`W${x.weekNumber}:${x.userWeekStatus}`);
async function main(){
  const ids:string[]=[];for(let f=0;;f+=1000){const{data}=await supabaseAdmin.from("user_profiles").select("user_id").range(f,f+999);if(!data||!data.length)break;ids.push(...data.map((r:any)=>r.user_id));if(data.length<1000)break;}
  for(const [name,p,growth] of [["김민아(비휴식 full)","052aeb95","active"],["카카오(비휴식 zeroUws)","c3ca54c0","active"]] as any[]){
    const id=ids.find(u=>u.startsWith(p)); if(!id){console.log(name,"못찾음");continue;}
    const { data: gp }=await supabaseAdmin.from("user_profiles").select("growth_status").eq("user_id",id).maybeSingle();
    const before=await readWeeklyCardsSnapshot(id); const bc=(before.status==="hit"||before.status==="stale")?(before.cards as any[]):[];
    await http(id); await sleep(14000); // version bump → bg 재계산
    const after=await readWeeklyCardsSnapshot(id); const ac=(after.status==="hit"||after.status==="stale")?(after.cards as any[]):[];
    console.log(`\n▶ ${name} ${id.slice(0,8)} growth=${(gp as any)?.growth_status}`);
    console.log(`  BEFORE 총=${bc.length} spring=[${spring(bc).join(" ")}]`);
    console.log(`  AFTER  총=${ac.length} spring=[${spring(ac).join(" ")}]`);
    console.log(`  변화없음? 총:${bc.length===ac.length} spring:${JSON.stringify(spring(bc))===JSON.stringify(spring(ac))}`);
  }
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
