import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main() {
  // week_id 유무별 experience 라인 분포.
  const { count: nullC } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("part_type","experience").is("week_id", null);
  const { count: setC } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("part_type","experience").not("week_id","is",null);
  console.log(`experience 라인: week_id=NULL ${nullC}건 · week_id 세팅 ${setC}건\n`);

  // week_id=NULL experience 라인 상세(개설 UI 생성분) — submission 창·team·org.
  const { data } = await supabaseAdmin.from("cluster4_lines")
    .select("id, line_code, main_title, team_id, submission_opens_at, submission_closes_at, is_qa_test, is_active, created_at")
    .eq("part_type","experience").is("week_id", null).order("submission_opens_at",{ascending:false});
  const rows = (data ?? []) as any[];
  // team → org 매핑.
  const teamIds = [...new Set(rows.map(r=>r.team_id).filter(Boolean))];
  const teamOrg = new Map<string,any>();
  if (teamIds.length) {
    const { data: teams } = await supabaseAdmin.from("cluster4_team_halves").select("id, organization_slug, team_name").in("id", teamIds);
    for (const t of (teams ?? []) as any[]) teamOrg.set(t.id, t);
  }
  console.log(`week_id=NULL experience 라인 ${rows.length}건:`);
  for (const r of rows) {
    const t = teamOrg.get(r.team_id);
    console.log(`  opens=${r.submission_opens_at?.slice(0,10)}~${r.submission_closes_at?.slice(0,10)} org=${t?.organization_slug ?? "?"} team=${t?.team_name ?? r.team_id} code=${r.line_code} qa=${r.is_qa_test} active=${r.is_active}`);
  }

  // 검수 대상 주차 창(2026-07-06 ~ 07-12) 과 겹치는 것.
  console.log(`\n검수대상 주차(2026-07-06~07-12) submission 창 겹침 라인:`);
  const wk_s = "2026-07-06", wk_e = "2026-07-12";
  const overlap = rows.filter(r => r.submission_opens_at && r.submission_opens_at.slice(0,10) <= wk_e && (r.submission_closes_at?.slice(0,10) ?? "9999") >= wk_s);
  for (const r of overlap) { const t = teamOrg.get(r.team_id); console.log(`  org=${t?.organization_slug} team=${t?.team_name} code=${r.line_code} opens=${r.submission_opens_at?.slice(0,10)}`); }
  console.log(`  → ${overlap.length}건`);
}
main().catch(e=>{console.error(e);process.exit(1);});
