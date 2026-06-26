import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
const env=process.env as Record<string,string>;
const raw=readFileSync(".env.local","utf8"); const g=(k:string)=>raw.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
const blank=(v:any)=>v==null||String(v).trim()===""||String(v).trim()==="-";
async function fa<T>(t:string,s:string,o:string):Promise<T[]>{const out:T[]=[];for(let f=0;;f+=1000){const{data,error}=await sb.from(t).select(s).order(o,{ascending:true}).range(f,f+999);if(error)throw new Error(error.message);out.push(...((data??[])as T[]));if((data??[]).length<1000)break;}return out;}
async function main(){
  const users=await fa<{id:string;legacy_user_id:number|null;source_system:string|null}>("users","id,legacy_user_id,source_system","id");
  const profs=await fa<{user_id:string;display_name:string|null;address:string|null}>("user_profiles","user_id,display_name,address","user_id");
  const uById=new Map(users.map(u=>[u.id,u]));
  const migrated=profs.filter(p=>{const u=uById.get(p.user_id);return u?.source_system&&u.legacy_user_id!=null;});
  const migratedBlank=migrated.filter(p=>blank(p.address));
  const nativeBlank=profs.filter(p=>{const u=uById.get(p.user_id);return !(u?.source_system)&&blank(p.address);});
  console.log("[Vraxium DB direct]");
  console.log(`  전체 ${profs.length} | address 채움 ${profs.filter(p=>!blank(p.address)).length} | 이관자 채움 ${migrated.length-migratedBlank.length}/${migrated.length}`);
  console.log(`  이관자 중 여전히 blank: ${migratedBlank.length} (0이어야 함)`);
  console.log(`  native(소스없음) blank: ${nativeBlank.length} (PMS 소스 없음 → 정상 미백필)`);

  // PMS direct cross-check: 백필된 이관자 10명 샘플 DB vs PMS
  const conn=await mysql.createConnection({host:"127.0.0.1",port:13306,user:g("MYSQL_USER"),password:g("MYSQL_PASSWORD"),dateStrings:true,ssl:{rejectUnauthorized:false}});
  const sample=migrated.filter(p=>!blank(p.address)).slice(0,10);
  console.log("\n[PMS direct ↔ DB direct 대조] (백필 10명)");
  let mismatch=0;
  for(const p of sample){
    const u=uById.get(p.user_id)!;
    const [[r]]=(await conn.query(`SELECT Address FROM ${u.source_system}.users WHERE UserId=?`,[u.legacy_user_id])) as any;
    const pms=String(r?.Address??"").trim();
    const ok=pms===String(p.address).trim();
    if(!ok)mismatch++;
    console.log(`  ${String(p.display_name).padEnd(8)} DB="${p.address}" | PMS="${pms}" ${ok?"✔":"✖"} [${u.source_system}]`);
  }
  await conn.end();
  console.log(`\n대조 불일치: ${mismatch} (0이어야 함)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
