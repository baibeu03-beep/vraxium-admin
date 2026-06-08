/**
 * 2E-5 설계용 read-only 조사 — career_projects 1건의 연결 관계 전수.
 *   npx tsx --env-file=.env.local scripts/diag-career-2e5.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: projects } = await sb.from("career_projects").select("*");
  console.log("=== career_projects 전수 ===");
  console.log(JSON.stringify(projects, null, 1));

  for (const p of projects ?? []) {
    const pid = p.id as string;
    console.log(`\n=== 연결 관계: ${pid} (${p.line_name}) ===`);
    const { data: lines } = await sb
      .from("cluster4_lines")
      .select("id,part_type,line_code,main_title,is_active,opened_at,created_at")
      .eq("career_project_id", pid);
    console.log("cluster4_lines 연결:", JSON.stringify(lines, null, 1));
    const lineIds = (lines ?? []).map((l) => l.id as string);
    if (lineIds.length > 0) {
      const { count: targets } = await sb
        .from("cluster4_line_targets")
        .select("*", { count: "exact", head: true })
        .in("line_id", lineIds);
      console.log("연결 라인의 targets:", targets);
      const { data: targetRows } = await sb
        .from("cluster4_line_targets")
        .select("id")
        .in("line_id", lineIds);
      const tids = (targetRows ?? []).map((t) => t.id as string);
      const { count: subs } = tids.length
        ? await sb
            .from("cluster4_line_submissions")
            .select("*", { count: "exact", head: true })
            .in("line_target_id", tids)
        : { count: 0 };
      console.log("연결 라인의 submissions:", subs);
    }
    const { count: weeks } = await sb
      .from("career_project_weeks")
      .select("*", { count: "exact", head: true })
      .eq("project_id", pid);
    console.log("career_project_weeks:", weeks);
    const { count: records } = await sb
      .from("career_records")
      .select("*", { count: "exact", head: true })
      .eq("project_id", pid);
    console.log("career_records:", records);
    const { count: evals } = await sb
      .from("cluster4_career_line_evaluations")
      .select("*", { count: "exact", head: true });
    console.log("career_line_evaluations(전체):", evals);
  }

  // 전체 career_records / career_project_weeks (다른 project 참조 가능성)
  const { count: allRecords } = await sb
    .from("career_records")
    .select("*", { count: "exact", head: true });
  const { count: allWeeks } = await sb
    .from("career_project_weeks")
    .select("*", { count: "exact", head: true });
  console.log(`\n전체: career_records=${allRecords}, career_project_weeks=${allWeeks}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
