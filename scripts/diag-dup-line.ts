import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const ids = ["26e3589a","7adcd26f"];
  // 풀 lineId 매칭(prefix).
  const { data: lines } = await sb.from("cluster4_lines").select("id,line_code,team_id,is_active,part_type,created_at,created_by").eq("line_code","EXBS-EL0001").eq("part_type","experience");
  console.log("EXBS-EL0001 experience 라인 전체:");
  for (const l of (lines??[]) as any[]) {
    const { data: t } = await sb.from("cluster4_line_targets").select("id,week_id,target_user_id").eq("line_id", l.id);
    const weeks = Array.from(new Set((t??[]).map((x:any)=>x.week_id)));
    console.log(`  lineId=${l.id.slice(0,8)} active=${l.is_active} team=${l.team_id?.slice(0,8)} created=${l.created_at?.slice(0,16)} targets=${(t??[]).length} weeks=${weeks.length}`);
    // 이 라인이 팀총괄 opened_lines 추적에 있나?
    const { data: tracked } = await sb.from("cluster4_experience_team_overall_opened_lines").select("overall_id").eq("line_id", l.id);
    console.log(`     team-overall 추적: ${(tracked??[]).length}건`);
  }
  // W13 + 음료(T) team 의 EXBS-EL0001 라인 수.
  const wk = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
  const { data: t13 } = await sb.from("cluster4_line_targets").select("line_id,target_user_id, cluster4_lines!inner(line_code,team_id,is_active)").eq("week_id", wk).eq("cluster4_lines.line_code","EXBS-EL0001");
  const byLine = new Map<string,number>();
  for (const r of (t13??[]) as any[]) byLine.set(r.line_id,(byLine.get(r.line_id)??0)+1);
  console.log(`\nW13 EXBS-EL0001 distinct 라인 수 = ${byLine.size} (각 lineId targets: ${[...byLine.entries()].map(([k,v])=>`${k.slice(0,8)}:${v}`).join(", ")})`);
})().catch(e=>{console.error(e);process.exit(1);});
