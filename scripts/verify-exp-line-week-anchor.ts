import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main() {
  const w = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // week 28
  // 현재(버그) 경로: cluster4_lines.week_id
  const { count: buggy } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("week_id", w).eq("part_type","experience");
  console.log(`[버그 경로] cluster4_lines.week_id=${w} & part_type=experience: ${buggy}건`);

  // 올바른 경로: cluster4_line_targets.week_id → line_id → part_type=experience 라인.
  const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("id, line_id").eq("week_id", w);
  const tgRows = (tg ?? []) as any[];
  const lineIds = [...new Set(tgRows.map(r=>r.line_id).filter(Boolean))];
  console.log(`\ncluster4_line_targets.week_id=${w}: ${tgRows.length}개 타깃, ${lineIds.length}개 라인`);
  // 그 라인 중 experience.
  const expLineIds: string[] = [];
  const CHUNK=200;
  for (let i=0;i<lineIds.length;i+=CHUNK){
    const { data } = await supabaseAdmin.from("cluster4_lines").select("id, part_type, team_id, week_id").in("id", lineIds.slice(i,i+CHUNK));
    for (const l of (data ?? []) as any[]) if (l.part_type==="experience") expLineIds.push(l.id);
  }
  console.log(`[올바른 경로] 그 타깃들이 가리키는 experience 라인: ${expLineIds.length}건`);
  // experience 타깃 수.
  const expTargets = tgRows.filter(r => expLineIds.includes(r.line_id));
  console.log(`experience 라인의 타깃(대상자) 수: ${expTargets.length}`);
  // 평가 행.
  const { count: evalC } = await supabaseAdmin.from("cluster4_experience_line_evaluations").select("id",{count:"exact",head:true}).in("line_target_id", expTargets.map(r=>r.id).slice(0,200));
  console.log(`평가 행(cluster4_experience_line_evaluations, 앞 200 타깃): ${evalC}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
