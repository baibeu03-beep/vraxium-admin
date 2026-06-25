import { createClient } from "@supabase/supabase-js";
const env = process.env as Record<string,string>;
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const blank=(v:any)=>v==null||String(v).trim()===""||String(v).trim()==="-";
async function fetchAll<T>(t:string,s:string,o:string):Promise<T[]>{const out:T[]=[];for(let f=0;;f+=1000){const{data,error}=await sb.from(t).select(s).order(o,{ascending:true}).range(f,f+999);if(error)throw new Error(error.message);out.push(...((data??[])as T[]));if((data??[]).length<1000)break;}return out;}
async function main(){
  const profs = await fetchAll<{user_id:string;display_name:string|null;english_name:string|null}>("user_profiles","user_id,display_name,english_name","user_id");
  const filled = profs.filter(p=>!blank(p.english_name));
  const blankN = profs.filter(p=>blank(p.english_name));
  console.log(`[DB direct] 전체 ${profs.length} | english_name 채움 ${filled.length} | 여전히 blank ${blankN.length}`);
  console.log("\n백필 결과 샘플 12 (한글명 → english_name):");
  for (const p of filled.slice(0,12)) console.log(`  ${String(p.display_name).padEnd(8)} → "${p.english_name}"`);
  if (blankN.length) { console.log("\n남은 blank 샘플:"); for(const p of blankN.slice(0,10)) console.log(`  user_id=${p.user_id} display_name=${JSON.stringify(p.display_name)}`); }
}
main().catch(e=>{console.error(e);process.exit(1);});
