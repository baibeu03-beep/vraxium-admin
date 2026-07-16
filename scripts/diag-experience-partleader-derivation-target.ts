// READ-ONLY 진단: 실무 경험 [팀 총괄] 개설 완료 팀에서, 파트장이 도출/분석/견문
//   (1) 파트 신청 셀(cluster4_experience_part_submission_cells)에 존재하는지
//   (2) 개설된 라인의 대상자(cluster4_line_targets)로 배정됐는지 를 대조한다.
//
//   가설: 파트장은 part_submission 그리드에서 제외되어 셀이 없고 → updateOverallPartCellLines
//         가 write-back 을 스킵 → selected_line_id 미저장 → 도출/분석/견문 라인 타깃 미생성.
//   run: npx tsx --env-file=.env.local scripts/diag-experience-partleader-derivation-target.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadTeamMembersWithLeaders } from "@/lib/adminExperienceTeamOverall";
import { resolveTeamNameById } from "@/lib/experienceImpersonation";

async function main() {
  // 1) 개설 완료(opened) 팀 총괄 헤더.
  const { data: opened } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("id,organization_slug,week_id,team_id,status,opened_at")
    .eq("status", "opened")
    .order("opened_at", { ascending: false })
    .limit(50);
  const rows = (opened ?? []) as Array<{
    id: string; organization_slug: string; week_id: string; team_id: string; opened_at: string | null;
  }>;
  console.log(`[opened team-overall] ${rows.length}건`);

  for (const o of rows) {
    const teamName = await resolveTeamNameById(o.team_id).catch(() => null);
    if (!teamName) { console.log(`  (team ${o.team_id} 이름해석 실패 — skip)`); continue; }
    const members = await loadTeamMembersWithLeaders(o.organization_slug, teamName, "operating");
    const testMembers = await loadTeamMembersWithLeaders(o.organization_slug, teamName, "test");
    const leaders = [...members, ...testMembers].filter((m) => m.isPartLeader);
    if (leaders.length === 0) continue;

    // 이 팀·주차 파트 신청 셀(도출/분석/견문) 로드.
    const { data: headers } = await supabaseAdmin
      .from("cluster4_experience_part_submissions")
      .select("id,part_name")
      .eq("organization_slug", o.organization_slug)
      .eq("week_id", o.week_id)
      .eq("team_id", o.team_id);
    const headerIds = ((headers ?? []) as Array<{ id: string; part_name: string }>).map((h) => h.id);
    const cellByUser = new Map<string, Array<{ line_type: string; selected_line_id: string | null; checked: boolean; score: number }>>();
    if (headerIds.length > 0) {
      const { data: cells } = await supabaseAdmin
        .from("cluster4_experience_part_submission_cells")
        .select("crew_user_id,line_type,selected_line_id,checked,score")
        .in("submission_id", headerIds);
      for (const c of (cells ?? []) as Array<{ crew_user_id: string; line_type: string; selected_line_id: string | null; checked: boolean; score: number }>) {
        const list = cellByUser.get(c.crew_user_id) ?? [];
        list.push({ line_type: c.line_type, selected_line_id: c.selected_line_id, checked: c.checked, score: c.score });
        cellByUser.set(c.crew_user_id, list);
      }
    }

    // 이 팀·주차 개설된 경험 라인 타깃(도출/분석/견문 라인의 target_user_id).
    const { data: openedLines } = await supabaseAdmin
      .from("cluster4_experience_team_overall_opened_lines")
      .select("line_id,category")
      .eq("overall_id", o.id);
    const lineIds = ((openedLines ?? []) as Array<{ line_id: string; category: string }>).map((r) => r.line_id);
    const partCatLineIds = ((openedLines ?? []) as Array<{ line_id: string; category: string }>)
      .filter((r) => ["derivation", "analysis", "evaluation"].includes(r.category))
      .map((r) => r.line_id);
    const targetUsers = new Set<string>();
    if (lineIds.length > 0) {
      const { data: tgts } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("target_user_id,line_id")
        .in("line_id", lineIds);
      for (const t of (tgts ?? []) as Array<{ target_user_id: string | null; line_id: string }>) {
        if (t.target_user_id && partCatLineIds.includes(t.line_id)) targetUsers.add(t.target_user_id);
      }
    }

    console.log(`\n■ ${o.organization_slug} / ${teamName} / week ${o.week_id.slice(0, 8)} (opened ${o.opened_at?.slice(0, 10)})`);
    for (const L of leaders) {
      const cells = cellByUser.get(L.userId) ?? [];
      const cellSummary = cells.length
        ? cells.map((c) => `${c.line_type}${c.selected_line_id ? "✓line" : "∅line"}(chk=${c.checked},s=${c.score})`).join(" ")
        : "(파트신청 셀 없음)";
      const isTarget = targetUsers.has(L.userId);
      console.log(`   파트장 ${L.displayName} [${L.partName}] ${L.userId.slice(0, 8)}`);
      console.log(`     part_submission_cells: ${cellSummary}`);
      console.log(`     도출/분석/견문 라인 대상자 배정?: ${isTarget ? "예(성공)" : "아니오(→강화 실패)"}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
