import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
const UUID="73b3fa9a-e875-43d0-a945-477237eb2f68";const LID=1301;const DB="hrdb";
async function main(){
  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const q=async(s:string,p:any[]=[])=>(await conn.query(s,p))[0] as any[];
  const bal=await q(`SELECT Star,Shield FROM ${DB}.userspoint WHERE UserID=?`,[LID]);
  console.log("userspoint.Star(balance) =", bal[0].Star, "Shield =", bal[0].Shield);
  const all=await q(`SELECT COUNT(*) n, SUM(Star) s FROM ${DB}.pointlogs WHERE UserID=?`,[LID]);
  const live=await q(`SELECT COUNT(*) n, SUM(Star) s FROM ${DB}.pointlogs WHERE UserID=? AND (IsDeleted IS NULL OR IsDeleted=0)`,[LID]);
  const del=await q(`SELECT COUNT(*) n, SUM(Star) s FROM ${DB}.pointlogs WHERE UserID=? AND IsDeleted=1`,[LID]);
  console.log(`pointlogs ALL: ${all[0].n}행 ΣStar=${all[0].s}`);
  console.log(`pointlogs IsDeleted=0: ${live[0].n}행 ΣStar=${live[0].s}`);
  console.log(`pointlogs IsDeleted=1: ${del[0].n}행 ΣStar=${del[0].s}`);
  // group by code to see big adjustments
  const byCode=await q(`SELECT code, COUNT(*) n, SUM(Star) s FROM ${DB}.pointlogs WHERE UserID=? AND (IsDeleted IS NULL OR IsDeleted=0) GROUP BY code ORDER BY s DESC`,[LID]);
  console.log("\npointlogs(live) code별 합:");
  for(const r of byCode) console.log(`  code=${r.code} ${r.n}행 ΣStar=${r.s}`);
  await conn.end();
  // Vraxium ledger + uwp
  let led:any[]=[];for(let f=0;;f+=1000){const{data}=await sb.from("legacy_point_ledger").select("star,entry_type,source_table,week_id").eq("user_id",UUID).range(f,f+999);led.push(...(data??[]));if((data??[]).length<1000)break;}
  const ledStar=led.reduce((a,r)=>a+(r.star??0),0);
  console.log(`\nVraxium legacy_point_ledger: ${led.length}행 Σstar=${ledStar}`);
  const {data:uwp}=await sb.from("user_weekly_points").select("points").eq("user_id",UUID).range(0,999);
  const vx=(uwp??[]).reduce((a:number,r:any)=>a+(r.points??0),0);
  console.log(`Vraxium user_weekly_points: Σpoints=${vx}`);
  console.log(`\n=== 차이 분해 ===`);
  console.log(`PMS balance(userspoint) 1676`);
  console.log(`PMS Σpointlogs(live)     ${live[0].s}`);
  console.log(`Vraxium Σledger          ${ledStar}`);
  console.log(`Vraxium Σuwp.points       ${vx}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
