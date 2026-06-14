import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  // b29f9050 팀 org.
  const { data: t } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").eq("id","b29f9050-0000-0000-0000-000000000000").maybeSingle();
  const { data: t2 } = await sb.from("cluster4_teams").select("id,team_name,organization_slug").ilike("id","b29f9050%");
  console.log("team b29f9050:", JSON.stringify(t2 ?? t));
  // 통합 라인(EXBS-EN%) 의 주차 분포 — 여름(>=2026-06-29) 주차에도 생성됐나?
  const { data: uni } = await sb.from("cluster4_lines").select("id,line_code,team_id").like("line_code","EXBS-EN26%").limit(50);
  const uniIds = (uni??[]).map((x:any)=>x.id);
  const { data: utgt } = await sb.from("cluster4_line_targets").select("week_id, weeks!inner(start_date)").in("line_id", uniIds.length?uniIds:["x"]);
  const dates = Array.from(new Set((utgt??[]).map((x:any)=>x.weeks?.start_date))).sort();
  console.log(`\n통합 라인(EXBS-EN26*) ${uniIds.length}개, 타깃 주차 start_date 범위: ${dates[0]} ~ ${dates[dates.length-1]}`);
  const summerUni = dates.filter((d:any)=>d>="2026-06-29");
  console.log(`  여름(>=2026-06-29) 주차 통합 타깃: ${summerUni.length}건 ${summerUni.length?"⚠":"(없음=레거시 전용 확인)"}`);
  // EXBS-EL0001/0002 등 BS common 라인이 여러 팀에 개설됐는지(누수 규모).
  for (const code of ["EXBS-EL0001","EXBS-EL0002"]) {
    const { data: l } = await sb.from("cluster4_lines").select("id,team_id, cluster4_teams(organization_slug)").eq("line_code",code).eq("is_active",true);
    const teams = new Set((l??[]).map((x:any)=>x.team_id));
    const orgs = new Set((l??[]).map((x:any)=>x.cluster4_teams?.organization_slug));
    console.log(`${code}: 활성 라인 ${(l??[]).length}개, distinct team ${teams.size}, org ${[...orgs].join(",")}`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
