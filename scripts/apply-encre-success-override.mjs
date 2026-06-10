// APPLY: weekly_league_success_overrides — encre 7주차 PMS 실측 성공수.
// REST write(신규 전용 테이블만). uws/uwp/snapshot 무변경. 멱등 upsert + rollback.
// 전제: db/migrations/2026-06-11_weekly_league_success_overrides.sql 적용(테이블 생성) 완료.
import { readFileSync, writeFileSync } from "node:fs";
const env=readFileSync(".env.local","utf8");const g=(k)=>env.match(new RegExp(`^${k}=(.+)$`,"m"))?.[1]?.trim();
const sbUrl=g("NEXT_PUBLIC_SUPABASE_URL"),sbKey=g("SUPABASE_SERVICE_ROLE_KEY");const SH={apikey:sbKey,Authorization:`Bearer ${sbKey}`,"Content-Type":"application/json"};
async function sbAll(p){const r=await fetch(`${sbUrl}/rest/v1/${p}`,{headers:SH});if(!r.ok)throw new Error(`${p} ${r.status} ${await r.text()}`);return r.json();}
async function tableExists(t){const r=await fetch(`${sbUrl}/rest/v1/${t}?select=*&limit=1`,{headers:SH});return r.ok;}
async function cnt(t){const r=await fetch(`${sbUrl}/rest/v1/${t}?select=id`,{headers:{...SH,Prefer:"count=exact",Range:"0-0"}});return Number((r.headers.get("content-range")||"*/0").split("/")[1]);}
const OVERRIDE={1:51,5:108,9:105,10:113,11:108,12:106,13:99},ORG="encre",SEASON="2026-spring";
if(!(await tableExists("weekly_league_success_overrides"))){console.error("❌ weekly_league_success_overrides 테이블 없음 — db/migrations/2026-06-11_weekly_league_success_overrides.sql 먼저 적용.");process.exit(1);}
const weeks=await sbAll(`weeks?select=start_date,week_number&season_key=eq.${SEASON}&week_number=in.(${Object.keys(OVERRIDE).join(",")})`);
const wsByWn=new Map(weeks.map(w=>[w.week_number,w.start_date]));
const beforeUws=await cnt("user_week_statuses");
const rows=Object.entries(OVERRIDE).map(([wn,succ])=>({organization_slug:ORG,week_start_date:wsByWn.get(Number(wn)),growth_success:succ,source:"pms_screen_2026spring",note:`행정공표 실측 성공수 W${wn}`}));
if(rows.some(r=>!r.week_start_date))throw new Error("week 매핑 실패");
const r=await fetch(`${sbUrl}/rest/v1/weekly_league_success_overrides?on_conflict=organization_slug,week_start_date`,{method:"POST",headers:{...SH,Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify(rows)});
if(!r.ok)throw new Error(`upsert 실패: ${r.status} ${await r.text()}`);
const ins=await r.json();
console.log(`weekly_league_success_overrides upsert ${ins.length}행 (encre):`);
for(const x of ins.sort((a,b)=>a.growth_success-b.growth_success))console.log(`  ${x.week_start_date} growth_success=${x.growth_success}`);
const afterUws=await cnt("user_week_statuses");
console.log(`\n총 ${await cnt("weekly_league_success_overrides")}행 · uws 무변경 ${beforeUws}→${afterUws} ${beforeUws===afterUws?"✅":"⚠"}`);
writeFileSync("claudedocs/apply-encre-success-override-rollback-20260611.json",JSON.stringify({rollback:"DELETE FROM weekly_league_success_overrides WHERE organization_slug='encre' AND source='pms_screen_2026spring';"},null,2));
console.log("📄 rollback: claudedocs/apply-encre-success-override-rollback-20260611.json");
