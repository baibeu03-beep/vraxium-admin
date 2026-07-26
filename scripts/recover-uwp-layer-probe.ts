// READ-ONLY — legacy baseline 분리(legacy = uwp − 활성 award) 실측 검증.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function pageAll<T>(b:(f:number,t:number)=>PromiseLike<{data:unknown;error:{message:string}|null}>):Promise<T[]>{const o:T[]=[];for(let f=0;;f+=1000){const{data,error}=await b(f,f+999);if(error)throw new Error(error.message);const r=(data??[])as T[];o.push(...r);if(r.length<1000)break;}return o;}
async function main(){
  const uwp = await pageAll<any>((f,t)=>supabaseAdmin.from("user_weekly_points").select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,checks_migrated").order("id").range(f,t));
  const ppa = await pageAll<any>((f,t)=>supabaseAdmin.from("process_point_awards").select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at,source").order("id").range(f,t));
  const aw = new Map<string,{a:number;adv:number;pen:number;rows:number;srcs:Set<string>}>();
  for (const r of ppa){ if(r.cancelled_at) continue; const k=`${r.user_id}|${r.year}|${r.week_number}`;
    const e=aw.get(k)??{a:0,adv:0,pen:0,rows:0,srcs:new Set<string>()};
    e.a+=r.point_check??0; e.adv+=r.point_advantage??0; e.pen+=Math.abs(r.point_penalty??0); e.rows++; e.srcs.add(r.source); aw.set(k,e);}
  let neg=0, negRows:string[]=[]; let awKeysWithUwp=0, awKeysNoUwp=0;
  let sumLegA=0,sumLegAdv=0,sumLegPen=0;
  const uwpKey=new Map<string,any>(); for(const r of uwp) uwpKey.set(`${r.user_id}|${r.year}|${r.week_number}`,r);
  for (const r of uwp){
    const k=`${r.user_id}|${r.year}|${r.week_number}`; const a=aw.get(k)??{a:0,adv:0,pen:0,rows:0,srcs:new Set()};
    const la=(r.points??0)-a.a, ladv=(r.advantages??0)-a.adv, lpen=(r.penalty??0)-a.pen;
    sumLegA+=la; sumLegAdv+=ladv; sumLegPen+=lpen;
    if(la<0||ladv<0||lpen<0){neg++; if(negRows.length<15) negRows.push(`${r.user_id} ${r.week_start_date} uwp=${r.points}/${r.advantages}/${r.penalty} award=${a.a}/${a.adv}/${a.pen} → legacy=${la}/${ladv}/${lpen}`);}
  }
  for (const k of aw.keys()) uwpKey.has(k)?awKeysWithUwp++:awKeysNoUwp++;
  console.log("uwp 행",uwp.length,"· 활성 award 키",aw.size);
  console.log("award 키 중 uwp 행 있음",awKeysWithUwp,"· 없음",awKeysNoUwp);
  console.log(`백필 결과 Σlegacy A/rawAdv/pen = ${sumLegA}/${sumLegAdv}/${sumLegPen}`);
  console.log(`  (검산: uwp합 24803/8956/3634 − award합 1454/517/1983 = ${24803-1454}/${8956-517}/${3634-1983})`);
  console.log("음수 legacy 행:",neg);
  for(const s of negRows) console.log("  ",s);
  // award 가 붙은 uwp 행의 현재값이 정확히 award 합과 같은가
  let exact=0, diff=0; const diffs:string[]=[];
  for (const [k,a] of aw){ const r=uwpKey.get(k); if(!r) continue;
    if((r.points??0)===a.a&&(r.advantages??0)===a.adv&&(r.penalty??0)===a.pen) exact++;
    else {diff++; if(diffs.length<10) diffs.push(`${r.user_id} ${r.week_start_date} uwp=${r.points}/${r.advantages}/${r.penalty} award=${a.a}/${a.adv}/${a.pen}`);}}
  console.log(`\naward 키 ${aw.size} 중 uwp==award 정확일치 ${exact} · 불일치 ${diff}`);
  for(const s of diffs) console.log("  ",s);
  // award 가 레거시 주차(2026-06-29 이전)에 붙은 경우 = era 게이트 누수
  const leak=[...aw.keys()].filter(k=>{const r=uwpKey.get(k); return r && r.week_start_date < "2026-06-29";});
  console.log(`\nera 게이트 누수(award 가 2026-06-29 이전 주차에 존재): ${leak.length}키`);
  for(const k of leak.slice(0,10)){const r=uwpKey.get(k); const a=aw.get(k)!; console.log(`   ${r.week_start_date} uwp=${r.points}/${r.advantages}/${r.penalty} award=${a.a}/${a.adv}/${a.pen} src=${[...a.srcs]}`);}
}
main().catch(e=>{console.error(e);process.exit(1)});
