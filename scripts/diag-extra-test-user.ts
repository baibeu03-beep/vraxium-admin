import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const { data: m } = await sb.from("test_user_markers").select("user_id,created_at,note").range(0,4999);
  const ids = (m??[]).map((x:any)=>x.user_id);
  const createdBy = new Map((m??[]).map((x:any)=>[x.user_id,{created_at:x.created_at,note:x.note}]));
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,organization_slug").in("user_id", ids);
  const pMap = new Map((profs??[]).map((p:any)=>[p.user_id,p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,team_name,part_name,is_current,membership_state").in("user_id", ids);
  const teamMap = new Map<string,any>();
  for (const r of (mems??[]) as any[]){ const e=teamMap.get(r.user_id); if(!e||(r.is_current&&!e.is_current)) teamMap.set(r.user_id,r); }
  // created_at 분포(배치 식별).
  const byDate = new Map<string,number>();
  for (const x of (m??[]) as any[]){ const d=(x.created_at??"?").slice(0,10); byDate.set(d,(byDate.get(d)??0)+1); }
  console.log("created_at 분포:", JSON.stringify(Object.fromEntries(byDate)));
  // encre 테스트 유저 팀 분포.
  console.log("\n[encre 테스트 유저 팀 분포]");
  const encre = ids.filter(id=>pMap.get(id)?.organization_slug==="encre");
  const teamCnt = new Map<string,number>();
  for (const id of encre){ const t=teamMap.get(id)?.team_name??"(팀없음)"; teamCnt.set(t,(teamCnt.get(t)??0)+1); }
  for (const [t,n] of teamCnt) console.log(`  ${t}: ${n}`);
  // (T) 아닌 팀 = 초과분 후보.
  console.log("\n[(T) 팀이 아닌 테스트 유저 = 초과/이질 후보]");
  for (const id of ids){
    const t=teamMap.get(id)?.team_name??null;
    if(!t || !t.includes("(T)")){
      const p=pMap.get(id); const c=createdBy.get(id);
      console.log(`  ${p?.display_name??"?"} | org=${p?.organization_slug??"-"} | team=${t??"없음"} | state=${teamMap.get(id)?.membership_state??"-"} | created=${(c?.created_at??"?").slice(0,10)} | note=${c?.note??"-"}`);
    }
  }
})().catch(e=>{console.error(e);process.exit(1);});
