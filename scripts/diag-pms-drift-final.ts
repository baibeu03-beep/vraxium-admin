/** READ-ONLY: 72 불일치가 'migration 이후 PMS 신규 적립'으로 설명되는지 전수 확인 + 결과표. */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
const DBS:Record<string,string>={oranke:"oranke",hrdb:"hrdb",olympus:"olympus"};
const CUT="2026-06-08"; // migration batch date
async function fa(t:string,c:string,f?:(q:any)=>any,ord="user_id"){const o:any[]=[];let from=0;const p=1000;for(;;){let q=sb.from(t).select(c).order(ord,{ascending:true}).range(from,from+p-1);if(f)q=f(q);const{data,error}=await q;if(error)throw new Error(t+":"+error.message);const b=(data??[])as any[];o.push(...b);if(b.length<p)break;from+=p;}return o;}
async function main(){
  const users=await fa("users","id,source_system,legacy_user_id",(q)=>q.in("source_system",["oranke","hrdb","olympus"]),"id");
  const mig=users.filter((u:any)=>u.legacy_user_id!=null&&DBS[u.source_system]);
  const profs=await fa("user_profiles","user_id,display_name,organization_slug");
  const pById=new Map(profs.map((p:any)=>[p.user_id,p]));
  const uwp=await fa("user_weekly_points","user_id,points");
  const vxSum=new Map<string,number>(); for(const r of uwp as any[])vxSum.set(r.user_id,(vxSum.get(r.user_id)??0)+(r.points??0));
  // ledger source_pks per user
  const led=await fa("legacy_point_ledger","user_id,source_pk");
  const ledByUser=new Map<string,Set<number>>(); for(const r of led as any[]){let s=ledByUser.get(r.user_id);if(!s){s=new Set();ledByUser.set(r.user_id,s);}s.add(Number(r.source_pk));}

  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const bal=new Map<string,number>();
  for(const src of Object.keys(DBS)){
    const uids=[...new Set(mig.filter((u:any)=>u.source_system===src).map((u:any)=>Number(u.legacy_user_id)))];
    for(let i=0;i<uids.length;i+=500){const c=uids.slice(i,i+500);const[b]=await conn.query(`SELECT UserID,Star FROM ${DBS[src]}.userspoint WHERE UserID IN (${c.join(",")})`)as any;for(const r of b)bal.set(`${src}:${r.UserID}`,Number(r.Star??0));}
  }
  // mismatches
  const rows:any[]=[];
  for(const u of mig as any[]){const b=bal.get(`${u.source_system}:${Number(u.legacy_user_id)}`);const vx=vxSum.get(u.id);if(b==null||vx==null)continue;const diff=b-vx;if(diff===0)continue;rows.push({u,b,vx,diff});}
  console.log("불일치",rows.length,"건 — 미이관 pointlog 분석 중...");

  let explained=0, partial=0; const out:any[]=[]; let postCutTotal=0, postCutGrantTotal=0;
  for(const {u,b,vx,diff} of rows){
    const src=u.source_system, uid=Number(u.legacy_user_id);
    const [plogs]=await conn.query(`SELECT LogNum,Star,IsDeleted,CAST(ActivityTime AS CHAR) at,log FROM ${src}.pointlogs WHERE UserID=?`,[uid]) as any;
    const ledset=ledByUser.get(u.id)??new Set();
    const dropped=plogs.filter((p:any)=>!ledset.has(Number(p.LogNum)));
    const droppedStar=dropped.reduce((a:number,p:any)=>a+(Number(p.Star)||0),0);
    const postCut=dropped.filter((p:any)=>String(p.at).slice(0,10)>=CUT);
    const postCutStar=postCut.reduce((a:number,p:any)=>a+(Number(p.Star)||0),0);
    const grant=postCut.filter((p:any)=>String(p.log).includes("심화 크루 별")||String(p.log).includes("심화 크루 단감"));
    const grantStar=grant.reduce((a:number,p:any)=>a+(Number(p.Star)||0),0);
    postCutTotal+=postCutStar; postCutGrantTotal+=grantStar;
    const p=pById.get(u.id);
    const cause = postCutStar===diff ? "migration 이후 PMS 신규적립(전액)" : (postCutStar>0?`migration 이후 적립(${postCutStar}) + 잔차(${diff-postCutStar})`:"기타(미이관/sentinel 잔차)");
    if(postCutStar===diff)explained++; else if(postCutStar>0)partial++;
    out.push({name:p?.display_name??"?",org:p?.organization_slug,key:`${src}:${uid}`,PMS:b,Vraxium:vx,차이:diff,"미이관(post-cut)":postCutStar,"그중 심화크루별":grantStar,원인:cause});
  }
  await conn.end();
  console.log(`\n전액설명(post-cut 적립==diff): ${explained} / 부분: ${partial} / 총 불일치 ${rows.length}`);
  console.log(`post-cut 미이관 합계=${postCutTotal} (그중 심화크루별/단감=${postCutGrantTotal})`);
  console.log("\n════ 결과표: 사용자/PMS/Vraxium/차이/원인 ════");
  console.table(out.sort((a,b)=>b.차이-a.차이));
}
main().catch(e=>{console.error(e);process.exit(1);});
