import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env=readFileSync(".env.local","utf8");const G=(k:string)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(G("NEXT_PUBLIC_SUPABASE_URL")!,G("SUPABASE_SERVICE_ROLE_KEY")!);
// 윤서영(hrdb:1301) + 클린 케이스 16e4d039(oranke:1305) + 5c5bd454(hrdb:1641,sent0,drift0)
const TARGETS=[["73b3fa9a-e875-43d0-a945-477237eb2f68","hrdb",1301],["16000b1f-30ad-4187-9754-11199a577a09","oranke",1176]];
async function main(){
  const conn=await mysql.createConnection({host:G("MYSQL_HOST"),port:Number(G("MYSQL_PORT")??3306),user:G("MYSQL_USER"),password:G("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  for(const [uuid,src,uid] of TARGETS as any[]){
    const [plogs]=await conn.query(`SELECT LogNum,code,log,Info,Star,Shield,IsDeleted,CAST(ActivityTime AS CHAR) at,CAST(createtime AS CHAR) ct FROM ${src}.pointlogs WHERE UserID=? ORDER BY LogNum`,[uid]) as any;
    // ledger source_pks
    let led:any[]=[];for(let f=0;;f+=1000){const{data}=await sb.from("legacy_point_ledger").select("source_pk,star,reason,occurred_at").eq("user_id",uuid).range(f,f+999);led.push(...(data??[]));if((data??[]).length<1000)break;}
    const ledPk=new Set(led.map((r:any)=>Number(r.source_pk)));
    const dropped=plogs.filter((p:any)=>!ledPk.has(Number(p.LogNum)));
    const droppedStar=dropped.reduce((a:number,p:any)=>a+(Number(p.Star)||0),0);
    console.log(`\n══ ${src}:${uid} (${uuid.slice(0,8)}) ══`);
    console.log(`pointlogs=${plogs.length} ledger=${led.length} dropped=${dropped.length} droppedΣStar=${droppedStar}`);
    console.log("미이관 pointlogs:");
    for(const p of dropped.slice(0,20)) console.log(`  LogNum=${p.LogNum} code=${p.code} Star=${p.Star} Shield=${p.Shield} del=${p.IsDeleted} at=${String(p.at).slice(0,10)} log=${JSON.stringify(String(p.log).slice(0,30))} info=${JSON.stringify(String(p.Info).slice(0,30))}`);
  }
  await conn.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
