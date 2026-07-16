/* eslint-disable @typescript-eslint/no-explicit-any */
// 실무경험 강화율 산식 수정 검증 + 영향 사용자 snapshot 재생성.
//   대상 = 팀 스코프 experience 라인 중 (team,week,category) master≥2 그룹의 배정 사용자(희석 대상).
//   각 사용자: 구(전체 non-na)/신(본인 배정) experience 강화율 · live==snapshot==회원상세 · uws 불변 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-rate-fix.ts [--recompute]
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser, breakdownFromLines } from "@/lib/cluster4WeeklyCardsData";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const RECOMPUTE = process.argv.includes("--recompute");
const KO:Record<string,string>={도출:"derivation",분석:"analysis",평가:"evaluation",확장:"extension",관리:"management"};

function expOldNew(lines:any[]) {
  const nonNa = lines.filter(l=>l.partType==="experience"&&l.enhancementStatus!=="not_applicable");
  const assigned = nonNa.filter(l=>!(l.lineId!=null&&l.lineTargetId==null));
  const rate=(c:number,a:number)=>a>0?Math.round(c/a*100):0;
  const oC=nonNa.filter(l=>l.enhancementStatus==="success").length, oA=nonNa.length;
  const nC=assigned.filter(l=>l.enhancementStatus==="success").length, nA=assigned.length;
  return { old:`${oC}/${oA}(${rate(oC,oA)}%)`, neo:`${nC}/${nA}(${rate(nC,nA)}%)`, nA };
}
function expRateFromBreakdown(lines:any[]){ const b=breakdownFromLines(lines as any).experience; return `${b.completed}/${b.available}`; }

let pass=0,fail=0; const ck=(ok:boolean,l:string)=>{ if(!ok)console.log(`   ✗ ${l}`); ok?pass++:fail++; };

async function affectedUsers(): Promise<Array<{user:string;week:string;cat:string}>> {
  const {data:regs}=await supabaseAdmin.from("line_registrations").select("line_type,bridged_master_id").eq("hub","experience").not("bridged_master_id","is",null);
  const mc=new Map<string,string>(); for(const r of (regs??[]) as any[]){const c=KO[r.line_type];if(c)mc.set(r.bridged_master_id,c);}
  const {data:lines}=await supabaseAdmin.from("cluster4_lines").select("id,team_id,experience_line_master_id").eq("part_type","experience").eq("is_active",true).not("team_id","is",null);
  const lm=new Map<string,any>(); for(const l of (lines??[]) as any[]) lm.set(l.id,{team:l.team_id,master:l.experience_line_master_id});
  const tbl=new Map<string,any[]>(); for(const id of lm.keys()){const {data:tg}=await supabaseAdmin.from("cluster4_line_targets").select("line_id,week_id,target_user_id").eq("line_id",id); if(tg&&tg.length)tbl.set(id,tg as any[]);}
  const gMaster=new Map<string,Set<string>>(), gUserWeek=new Map<string,Set<string>>();
  const bump=(m:any,k:string)=>{let s=m.get(k);if(!s){s=new Set();m.set(k,s);}return s;};
  for(const [id,info] of lm){const cat=info.master?mc.get(info.master):null; if(!cat||!info.team)continue; for(const t of (tbl.get(id)??[])){const key=`${info.team}::${t.week_id}::${cat}`; bump(gMaster,key).add(info.master); if(t.target_user_id) bump(gUserWeek,key).add(`${t.target_user_id}::${t.week_id}::${cat}`);}}
  const out:Array<{user:string;week:string;cat:string}>=[];
  for(const [key,masters] of gMaster){ if(masters.size<2)continue; for(const uw of (gUserWeek.get(key)??[])){const [user,week,cat]=uw.split("::"); out.push({user,week,cat});}}
  // 사용자별 유니크(주차 무관 카드 조회는 1회).
  return out;
}

async function main(){
  const aff = await affectedUsers();
  const users = Array.from(new Set(aff.map(a=>a.user)));
  const weeksByUser = new Map<string,Set<string>>();
  for(const a of aff){ const s=weeksByUser.get(a.user)??new Set(); s.add(a.week); weeksByUser.set(a.user,s); }
  console.log(`영향 사용자: ${users.length}명 (희석 주차 카드 대조)\n`);

  if(RECOMPUTE){ console.log("snapshot 재생성 중..."); for(const u of users) await recomputeAndStoreWeeklyCardsSnapshot(u).catch(()=>{}); console.log("완료\n"); }

  console.log("user       week      | 구(전체)        → 신(배정)       | uws(live/snap) | live=snap=상세");
  for(const u of users){
    const live=await getCluster4WeeklyCardsForProfileUser(u).catch(()=>[] as any[]);
    const snap=await readWeeklyCardsSnapshot(u);
    const rc=await resolveCrewWeekCard(u,[...(weeksByUser.get(u)!)][0]).catch(()=>null as any);
    for(const wk of weeksByUser.get(u)!){
      const lc=live.find((c:any)=>c.weekId===wk); if(!lc)continue;
      const on=expOldNew(lc.lines);
      const sc=(snap.status==="hit"||snap.status==="stale")?snap.cards.find((c:any)=>c.weekId===wk):null;
      const rcCard=(rc&&rc.ok&&rc.card.weekId===wk)?rc.card:(await resolveCrewWeekCard(u,wk).then((r:any)=>r.ok?r.card:null).catch(()=>null));
      const liveRate=expRateFromBreakdown(lc.lines);
      const snapRate=sc?expRateFromBreakdown(sc.lines):"∅";
      const rcRate=rcCard?expRateFromBreakdown(rcCard.lines):"∅";
      const uwsLive=lc.userWeekStatus, uwsSnap=sc?.userWeekStatus??"∅";
      const consistent = snapRate===liveRate && rcRate===liveRate;
      console.log(`${u.slice(0,8)} ${wk.slice(0,8)} | ${on.old.padEnd(14)} → ${on.neo.padEnd(14)} | ${uwsLive}/${uwsSnap} | ${consistent?"✓":"✗ live="+liveRate+" snap="+snapRate+" 상세="+rcRate}`);
      ck(consistent, `${u.slice(0,8)} ${wk.slice(0,8)} live==snap==상세`);
      ck(uwsSnap==="∅"||uwsLive===uwsSnap, `${u.slice(0,8)} ${wk.slice(0,8)} uws 불변(live==snap)`);
      // 미배정만 있는 사용자는 0/0(강화율 표시 없음), 배정 있으면 분모>0.
    }
  }
  console.log(`\n검증: ${pass} pass / ${fail} fail`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
