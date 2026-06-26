/** READ-ONLY: 윤서영 PMS(hrdb) ↔ Vraxium 별점 차이 분해. */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env = readFileSync(".env.local","utf8");
const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
const UUID="73b3fa9a-e875-43d0-a945-477237eb2f68";

async function main(){
  const { data: u } = await sb.from("users").select("id,source_system,legacy_user_id").eq("id",UUID).maybeSingle();
  const src=(u as any)?.source_system, lid=Number((u as any)?.legacy_user_id);
  console.log("Vraxium users:", JSON.stringify(u));
  const db = src; // hrdb

  const conn = await mysql.createConnection({ host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const q=async(s:string,p:any[]=[])=>(await conn.query(s,p))[0] as any[];

  // what tables exist in hrdb that contain Star?
  const tbls = await q(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND COLUMN_NAME IN ('Star','Shield','Point') ORDER BY TABLE_NAME`,[db]);
  console.log(`\n[${db}] Star/Shield 보유 테이블:`, JSON.stringify(tbls));

  // balance
  const bal = await q(`SELECT * FROM \`${db}\`.userspoint WHERE UserID=?`,[lid]).catch(e=>[{err:e.message}]);
  console.log(`\nuserspoint(잔액):`, JSON.stringify(bal));

  // pointlogs sum + breakdown by reason/type if columns exist
  const plogCols = await q(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='pointlogs'`,[db]).catch(()=>[]);
  console.log(`pointlogs 컬럼:`, JSON.stringify(plogCols.map((c:any)=>c.COLUMN_NAME)));
  const plogSum = await q(`SELECT COUNT(*) n, SUM(Star) sumStar, MIN(CAST(CreatedAt AS CHAR)) minT, MAX(CAST(CreatedAt AS CHAR)) maxT FROM \`${db}\`.pointlogs WHERE UserID=?`,[lid]).catch(e=>[{err:e.message}]);
  console.log(`pointlogs 합:`, JSON.stringify(plogSum));

  // per-week star from activities
  let actStar=0;
  for (const t of ["useractivities","manageractivities"]){
    const rows = await q(`SELECT Season,SeasonWeek,Star,IsActive,CAST(StartDate AS CHAR) s FROM \`${db}\`.${t} WHERE UserId=? ORDER BY StartDate`,[lid]).catch(()=>[]);
    const sum = rows.reduce((a:number,r:any)=>a+(Number(r.Star)||0),0);
    actStar+=sum;
    console.log(`${t}: ${rows.length}행 ΣStar=${sum}`);
  }
  console.log("활동합 ΣStar(user+manager)=",actStar);
  await conn.end();

  // Vraxium
  const { data: uwp } = await sb.from("user_weekly_points").select("week_start_date,year,week_number,points,advantages,penalty,checks_migrated").eq("user_id",UUID).order("week_start_date").range(0,999);
  const rows=(uwp??[]) as any[];
  const vxSum=rows.reduce((a,r)=>a+(r.points??0),0);
  const sentinel=rows.find(r=>r.week_start_date==="1900-01-01"||(r.year===1900));
  console.log(`\nVraxium uwp ${rows.length}행 Σpoints=${vxSum}`);
  console.log("sentinel(1900):", sentinel?JSON.stringify(sentinel):"없음");
  const { count: ledgerN } = await sb.from("legacy_point_ledger").select("id",{count:"exact",head:true}).eq("user_id",UUID);
  console.log("legacy_point_ledger 행수:", ledgerN);
  // ledger sum if has star/points col
  const { data: led } = await sb.from("legacy_point_ledger").select("*").eq("user_id",UUID).limit(5);
  console.log("ledger 샘플:", JSON.stringify(led));
}
main().catch(e=>{console.error(e);process.exit(1);});
