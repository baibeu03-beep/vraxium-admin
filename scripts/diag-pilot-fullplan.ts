import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { normalizePmsSeasonType, isExcludedPmsSeason } from "@/lib/pmsSeasonAttribution";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const addDays=(iso:string,d:number)=>{const t=new Date(iso+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+d);return t.toISOString().slice(0,10);};
async function main(){
  const SRC="olympus";const PILOT=[{lg:253,name:"권원중",uid:"361f69d5-a718-4675-bbcb-15b8f69bf431",target:29},{lg:259,name:"권희윤",uid:"f7c159f8-ad78-46fd-b4c7-d39e6229f2e2",target:26}];
  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const q=async(s:string,p:any[]=[])=>(await conn.query(s,p))[0] as any[];
  const { data: weeks }=await supabaseAdmin.from("weeks").select("id,season_key,week_number,iso_year,iso_week,start_date,end_date");
  const weekByRange=(d:string)=>weeks!.find((w:any)=>d>=w.start_date&&d<=w.end_date)??null;
  const plan:any={};let totUws=0,totUwp=0;
  for(const p of PILOT){
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
    const CORR=`CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR) WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const plogs=await q(`SELECT Star,CAST(${CORR} AS CHAR) corrected FROM ${SRC}.pointlogs WHERE UserID=? AND IsDeleted=0`,[p.lg]);
    const uwpAgg=new Map<string,number>();for(const r of plogs){const w=weekByRange(String(r.corrected));if(w)uwpAgg.set(w.id,(uwpAgg.get(w.id)??0)+Number(r.Star??0));}
    const exUws=new Set(((await supabaseAdmin.from("user_week_statuses").select("week_start_date").eq("user_id",p.uid)).data??[]).map((r:any)=>r.week_start_date));
    const exUwp=new Set(((await supabaseAdmin.from("user_weekly_points").select("week_start_date").eq("user_id",p.uid)).data??[]).map((r:any)=>r.week_start_date));
    const allW=[...wp.values()];
    const transCnt=allW.filter(v=>isTransitionWeekStart(v.week.start_date)).length;
    const cumulative=allW.length-transCnt;
    const missUws=allW.filter(v=>!exUws.has(v.week.start_date));
    const missUwp=[...uwpAgg.keys()].filter(wid=>{const w=weeks!.find((x:any)=>x.id===wid);return !exUwp.has(w.start_date);});
    // 시즌별 누락
    const seasonMiss:any={};for(const v of missUws){seasonMiss[v.week.season_key]=(seasonMiss[v.week.season_key]||0)+1;}
    console.log(`\n■ ${p.name}: 귀속 ${allW.length}주(전환 ${transCnt}) → cumulative ${cumulative} vs 목표 ${p.target} ${cumulative===p.target?"✅":"차이 "+(cumulative-p.target)}`);
    console.log(`  누락 uws ${missUws.length}행 · 누락 uwp ${missUwp.length}행 · 시즌별 누락 uws: ${JSON.stringify(seasonMiss)}`);
    totUws+=missUws.length;totUwp+=missUwp.length;
    plan[p.name]={missUws:missUws.length,missUwp:missUwp.length,cumulative,target:p.target,trans:transCnt,seasonMiss};
  }
  console.log(`\n[전체 생성 예정] uws ${totUws}행 · uwp ${totUwp}행 (2명, 기존 31명 중 이 2명만)`);
  writeFileSync("claudedocs/pilot-fullplan-20260611.json",JSON.stringify(plan,null,2));
  console.log("📄 claudedocs/pilot-fullplan-20260611.json");
  await conn.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
