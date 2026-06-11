import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { normalizePmsSeasonType, isExcludedPmsSeason } from "@/lib/pmsSeasonAttribution";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const addDays=(iso:string,d:number)=>{const t=new Date(iso+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+d);return t.toISOString().slice(0,10);};
async function main(){
  const SRC="olympus";const PILOT=[{lg:253,name:"권원중",uid:"361f69d5-a718-4675-bbcb-15b8f69bf431",target:29},{lg:259,name:"권희윤",uid:"f7c159f8-ad78-46fd-b4c7-d39e6229f2e2",target:26}];
  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const q=async(s:string,p:any[]=[])=>(await conn.query(s,p))[0] as any[];
  // admin 전 시즌 주차
  const { data: weeks }=await supabaseAdmin.from("weeks").select("id,season_key,week_number,iso_year,iso_week,start_date,end_date");
  const weekByRange=(d:string)=>weeks!.find((w:any)=>d>=w.start_date&&d<=w.end_date)??null;
  console.log(`admin weeks 전체 ${weeks!.length} · season_key: ${[...new Set(weeks!.map((w:any)=>w.season_key))].sort().join(", ")}`);
  // olympus weekssettings 시즌(이 유저들 활동 시즌)
  for(const p of PILOT){
    console.log(`\n${"=".repeat(60)}\n■ ${p.name}(${p.lg}) 목표 누적 ${p.target}주`);
    // 전체 useractivities/manageractivities → 주차귀속 + IsActive
    const wp=new Map<string,{week:any;recognized:boolean}>();
    for(const table of ["useractivities","manageractivities"]){
      const rows=await q(`SELECT Season,SeasonWeek,IsActive,CAST(StartDate AS CHAR) StartDate,CAST(EndDate AS CHAR) EndDate FROM ${SRC}.${table} WHERE UserId=?`,[p.lg]);
      for(const r of rows){if(isExcludedPmsSeason(r.Season))continue;const type=normalizePmsSeasonType(r.Season);
        const cands=type?weeks!.filter((w:any)=>w.season_key.endsWith(`-${type}`)&&w.week_number===r.SeasonWeek):[];
        const dates=[r.StartDate,r.EndDate].filter(Boolean).map((d:string)=>String(d).slice(0,10));let w:any=null;
        for(const c of cands){const lo=addDays(c.start_date,-60),hi=addDays(c.end_date,180);if(dates.some((d:string)=>d>=lo&&d<=hi)){w=c;break;}}
        if(!w&&dates.length)w=weekByRange(dates[0])??(dates[1]?weekByRange(dates[1]):null);
        if(!w)continue;let v=wp.get(w.id);if(!v){v={week:w,recognized:false};wp.set(w.id,v);}if(r.IsActive===1)v.recognized=true;}
    }
    // pointlogs → uwp 주차
    const CORR=`CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR) WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const plogs=await q(`SELECT Star,CAST(${CORR} AS CHAR) corrected FROM ${SRC}.pointlogs WHERE UserID=? AND IsDeleted=0`,[p.lg]);
    const uwpWeeks=new Set<string>();for(const r of plogs){const w=weekByRange(String(r.corrected));if(w)uwpWeeks.add(w.id);}
    // 기존 admin uws/uwp
    const exUws=new Set(((await supabaseAdmin.from("user_week_statuses").select("week_start_date").eq("user_id",p.uid)).data??[]).map((r:any)=>r.week_start_date));
    const exUwp=new Set(((await supabaseAdmin.from("user_weekly_points").select("week_start_date").eq("user_id",p.uid)).data??[]).map((r:any)=>r.week_start_date));
    // 시즌별 분포
    const bySeasonUws:any={},bySeasonUwp:any={};
    for(const [,v] of wp){bySeasonUws[v.week.season_key]=(bySeasonUws[v.week.season_key]||0)+1;}
    for(const wid of uwpWeeks){const w=weeks!.find((x:any)=>x.id===wid);bySeasonUwp[w.season_key]=(bySeasonUwp[w.season_key]||0)+1;}
    const totalUws=wp.size, missUws=[...wp.values()].filter(v=>!exUws.has(v.week.start_date)).length;
    const totalUwp=uwpWeeks.size, missUwp=[...uwpWeeks].filter(wid=>{const w=weeks!.find((x:any)=>x.id===wid);return !exUwp.has(w.start_date);}).length;
    console.log(`  uws 귀속주차 총 ${totalUws} (기존 admin ${exUws.size} → 누락 ${missUws}) · 목표누적 ${p.target}`);
    console.log(`  uwp 귀속주차 총 ${totalUwp} (기존 admin ${exUwp.size} → 누락 ${missUwp})`);
    console.log(`  uws 시즌분포: ${JSON.stringify(bySeasonUws)}`);
    console.log(`  → 누적 ${totalUws}주가 목표 ${p.target}와 ${totalUws===p.target?"일치 ✅":`차이 ${totalUws-p.target}`}`);
  }
  await conn.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
