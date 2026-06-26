/** READ-ONLY 전수: PMS userspoint.Star(balance) ↔ Vraxium Σuwp.points. */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
const DBS:Record<string,string>={oranke:"oranke",hrdb:"hrdb",olympus:"olympus"};
async function fetchAll(t:string,c:string,f?:(q:any)=>any,ord:string="user_id"){const o:any[]=[];let from=0;const p=1000;for(;;){let q=sb.from(t).select(c).order(ord,{ascending:true}).range(from,from+p-1);if(f)q=f(q);const{data,error}=await q;if(error)throw new Error(t+":"+error.message);const b=(data??[])as any[];o.push(...b);if(b.length<p)break;from+=p;}return o;}
async function main(){
  // 1) Vraxium migrated users
  const users=await fetchAll("users","id,source_system,legacy_user_id",(q)=>q.in("source_system",["oranke","hrdb","olympus"]),"id");
  const mig=users.filter((u:any)=>u.legacy_user_id!=null && DBS[u.source_system]);
  console.log("migrated users(oranke/hrdb/olympus):",mig.length);
  // 2) Vraxium uwp sums + sentinel
  const uwp=await fetchAll("user_weekly_points","user_id,week_start_date,points");
  const vxSum=new Map<string,number>(); const sent=new Map<string,number>();
  for(const r of uwp as any[]){ vxSum.set(r.user_id,(vxSum.get(r.user_id)??0)+(r.points??0)); if(r.week_start_date==="1900-01-01")sent.set(r.user_id,(sent.get(r.user_id)??0)+(r.points??0)); }
  // 3) PMS balances per DB (bulk)
  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const balByKey=new Map<string,{star:number,shield:number}>(); // src:uid
  const plogByKey=new Map<string,number>();
  for(const src of Object.keys(DBS)){
    const uids=[...new Set(mig.filter((u:any)=>u.source_system===src).map((u:any)=>Number(u.legacy_user_id)))];
    if(!uids.length)continue;
    for(let i=0;i<uids.length;i+=500){
      const chunk=uids.slice(i,i+500);
      const [b]=await conn.query(`SELECT UserID,Star,Shield FROM ${DBS[src]}.userspoint WHERE UserID IN (${chunk.join(",")})`) as any;
      for(const r of b) balByKey.set(`${src}:${r.UserID}`,{star:Number(r.Star??0),shield:Number(r.Shield??0)});
      const [p]=await conn.query(`SELECT UserID,SUM(Star) s FROM ${DBS[src]}.pointlogs WHERE UserID IN (${chunk.join(",")}) GROUP BY UserID`) as any;
      for(const r of p) plogByKey.set(`${src}:${r.UserID}`,Number(r.s??0));
    }
  }
  await conn.end();
  // 4) compare + bucket
  let n=0,match=0,mismatch=0,noBal=0;
  let maxDiff=0; const buckets=new Map<string,number>(); const rowsOut:any[]=[];
  const inc=(k:string)=>buckets.set(k,(buckets.get(k)??0)+1);
  for(const u of mig as any[]){
    const key=`${u.source_system}:${Number(u.legacy_user_id)}`;
    const bal=balByKey.get(key); const vx=vxSum.get(u.id);
    if(!bal){noBal++;continue;}
    if(vx==null){continue;}
    n++;
    const diff=bal.star-vx; // PMS - Vraxium
    if(diff===0){match++;inc("정합(diff=0)");continue;}
    mismatch++; maxDiff=Math.max(maxDiff,Math.abs(diff));
    const plog=plogByKey.get(key)??null;
    const pmsInternal = plog!=null ? bal.star-plog : null; // balance vs own logs
    let cause="기타";
    if(plog!=null && bal.star!==plog && Math.abs(pmsInternal!)>=Math.abs(diff)) cause="PMS 내부 balance≠pointlogs";
    else if(sent.has(u.id)) cause="sentinel 미정합(잔차)";
    else cause="sentinel 없음/기타";
    inc(cause);
    rowsOut.push({key,uuid:u.id.slice(0,8),pms_balance:bal.star,pms_plogs:plog,vraxium:vx,diff,sentinel:sent.get(u.id)??null,pms_internal_drift:pmsInternal,cause});
  }
  console.log("\n════════ PMS ↔ Vraxium 별점 전수 census ════════");
  console.table([{비교유저:n,정합:match,불일치:mismatch,"PMS잔액행없음":noBal,"최대차이":maxDiff}]);
  console.log("\n원인별 건수:"); for(const[k,v]of[...buckets.entries()].sort((a,b)=>b[1]-a[1]))console.log(`  ${k}: ${v}`);
  // diff 분포
  const dist=new Map<number,number>(); for(const r of rowsOut)dist.set(Math.sign(r.diff),(dist.get(Math.sign(r.diff))??0)+1);
  console.log("\ndiff 부호 분포(PMS-Vraxium):",{양수_PMS높음:dist.get(1)??0,음수_Vraxium높음:dist.get(-1)??0});
  console.log("\n불일치 상위 40(|diff| 내림차순):");
  console.table(rowsOut.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff)).slice(0,40));
  // 윤서영
  const ysy=rowsOut.find(r=>r.uuid==="73b3fa9a"); console.log("\n윤서영:",JSON.stringify(ysy));
}
main().catch(e=>{console.error(e);process.exit(1);});
