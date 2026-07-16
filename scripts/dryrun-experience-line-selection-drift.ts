// READ-ONLY 진단(백필 판단용): 기존 개설 완료(opened) 실무 경험 팀에서
//   [사용자별 선택 라인]  cluster4_experience_part_submission_cells.selected_line_id
//                        (+ cluster4_experience_team_overall_cells.selected_line_id: 관리/확장)
//   vs
//   [실제 배정 라인]      cluster4_line_targets → cluster4_lines.experience_line_master_id
//   가 어긋난 (org/week/team/user/category) 행을 출력한다. write 0.
//
//   불일치 = 구 resolveCategoryLineGroups 축약(도출/분석=첫 라인·견문=누적주차·관리=역할)으로
//            사용자가 고른 라인과 실제 개설 라인이 달라진 케이스(= 크루 페이지 오표시분).
//   run: npx tsx --env-file=.env.local scripts/dryrun-experience-line-selection-drift.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KO_TO_CAT: Record<string, string> = {
  도출: "derivation",
  분석: "analysis",
  평가: "evaluation",
  확장: "extension",
  관리: "management",
};
const CAT_LABEL: Record<string, string> = {
  derivation: "도출",
  analysis: "분석",
  evaluation: "견문",
  extension: "확장",
  management: "관리",
};

async function main() {
  // 1) master(bridged) → category 맵 (개설 라인 카테고리 판정 = 옵션/개설 경로와 동일 원천).
  const { data: regs } = await supabaseAdmin
    .from("line_registrations")
    .select("line_type,bridged_master_id")
    .eq("hub", "experience")
    .not("bridged_master_id", "is", null);
  const masterCat = new Map<string, string>();
  for (const r of (regs ?? []) as Array<{ line_type: string; bridged_master_id: string }>) {
    const cat = KO_TO_CAT[r.line_type];
    if (cat) masterCat.set(r.bridged_master_id, cat);
  }

  // 2) 개설 완료 팀 총괄 헤더.
  const { data: opened } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("organization_slug,week_id,team_id,status,opened_at")
    .eq("status", "opened");
  const headers = (opened ?? []) as Array<{
    organization_slug: string;
    week_id: string;
    team_id: string;
    opened_at: string | null;
  }>;
  console.log(`[opened team-overall] ${headers.length}건 스캔\n`);

  type DriftRow = {
    org: string;
    weekId: string;
    teamId: string;
    userId: string;
    category: string;
    selectedMaster: string | null;
    assignedMaster: string | null;
    kind: "mismatch" | "assigned-not-selected" | "selected-not-assigned";
  };
  const drifts: DriftRow[] = [];
  let targetsScanned = 0;

  for (const h of headers) {
    // 2a) 사용자별 선택 라인(카테고리별).
    const selectedByUserCat = new Map<string, string | null>(); // `${user}::${cat}` → master
    // part 셀(도출/분석/견문) — checked & score>0 만 유효(보이드=null).
    const { data: pHeaders } = await supabaseAdmin
      .from("cluster4_experience_part_submissions")
      .select("id")
      .eq("organization_slug", h.organization_slug)
      .eq("week_id", h.week_id)
      .eq("team_id", h.team_id);
    const pIds = ((pHeaders ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (pIds.length > 0) {
      const { data: pCells } = await supabaseAdmin
        .from("cluster4_experience_part_submission_cells")
        .select("crew_user_id,line_type,selected_line_id,checked,score")
        .in("submission_id", pIds);
      for (const c of (pCells ?? []) as Array<{
        crew_user_id: string;
        line_type: string;
        selected_line_id: string | null;
        checked: boolean;
        score: number;
      }>) {
        const valid = c.checked && c.score > 0 ? c.selected_line_id : null;
        selectedByUserCat.set(`${c.crew_user_id}::${c.line_type}`, valid);
      }
    }
    // overall 셀(관리/확장).
    const { data: oHeader } = await supabaseAdmin
      .from("cluster4_experience_team_overall")
      .select("id")
      .eq("organization_slug", h.organization_slug)
      .eq("week_id", h.week_id)
      .eq("team_id", h.team_id)
      .maybeSingle();
    const oId = (oHeader as { id: string } | null)?.id ?? null;
    if (oId) {
      const { data: oCells } = await supabaseAdmin
        .from("cluster4_experience_team_overall_cells")
        .select("crew_user_id,category,selected_line_id,checked,score")
        .eq("overall_id", oId);
      for (const c of (oCells ?? []) as Array<{
        crew_user_id: string;
        category: string;
        selected_line_id: string | null;
        checked: boolean;
        score: number;
      }>) {
        const valid = c.checked && c.score > 0 ? c.selected_line_id : null;
        selectedByUserCat.set(`${c.crew_user_id}::${c.category}`, valid);
      }
    }

    // 2b) 실제 배정 라인(카테고리별): 이 팀의 experience 라인 → 이 주차 타깃.
    const { data: teamLines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,experience_line_master_id")
      .eq("part_type", "experience")
      .eq("team_id", h.team_id);
    const lineMaster = new Map<string, string | null>();
    for (const l of (teamLines ?? []) as Array<{ id: string; experience_line_master_id: string | null }>) {
      lineMaster.set(l.id, l.experience_line_master_id);
    }
    const lineIds = Array.from(lineMaster.keys());
    const assignedByUserCat = new Map<string, string>(); // `${user}::${cat}` → assigned master
    if (lineIds.length > 0) {
      const { data: tgts } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id,target_user_id,week_id")
        .in("line_id", lineIds)
        .eq("week_id", h.week_id);
      for (const t of (tgts ?? []) as Array<{ line_id: string; target_user_id: string | null; week_id: string }>) {
        if (!t.target_user_id) continue;
        const master = lineMaster.get(t.line_id) ?? null;
        if (!master) continue;
        const cat = masterCat.get(master);
        if (!cat) continue;
        targetsScanned++;
        assignedByUserCat.set(`${t.target_user_id}::${cat}`, master);
      }
    }

    // 2c) 대조.
    const keys = new Set<string>([...selectedByUserCat.keys(), ...assignedByUserCat.keys()]);
    for (const key of keys) {
      const [userId, category] = key.split("::");
      const selected = selectedByUserCat.get(key) ?? null;
      const assigned = assignedByUserCat.get(key) ?? null;
      if (assigned && selected && assigned !== selected) {
        drifts.push({ org: h.organization_slug, weekId: h.week_id, teamId: h.team_id, userId, category, selectedMaster: selected, assignedMaster: assigned, kind: "mismatch" });
      } else if (assigned && !selected) {
        // 배정은 있는데 선택 없음 = 구 자동라우팅(견문 누적주차/관리 역할)로만 배정된 케이스.
        drifts.push({ org: h.organization_slug, weekId: h.week_id, teamId: h.team_id, userId, category, selectedMaster: null, assignedMaster: assigned, kind: "assigned-not-selected" });
      } else if (!assigned && selected) {
        drifts.push({ org: h.organization_slug, weekId: h.week_id, teamId: h.team_id, userId, category, selectedMaster: selected, assignedMaster: null, kind: "selected-not-assigned" });
      }
    }
  }

  // 3) 리포트.
  console.log(`타깃 스캔: ${targetsScanned}건 · 불일치: ${drifts.length}건\n`);
  const mismatch = drifts.filter((d) => d.kind === "mismatch");
  const assignedNotSel = drifts.filter((d) => d.kind === "assigned-not-selected");
  const selNotAssigned = drifts.filter((d) => d.kind === "selected-not-assigned");
  console.log(`  ▸ 선택≠배정(오표시 핵심):        ${mismatch.length}건`);
  console.log(`  ▸ 배정 있음/선택 없음(자동라우팅): ${assignedNotSel.length}건`);
  console.log(`  ▸ 선택 있음/배정 없음:            ${selNotAssigned.length}건\n`);

  const byGroup = new Map<string, DriftRow[]>();
  for (const d of drifts) {
    const g = `${d.org} · week=${d.weekId} · team=${d.teamId}`;
    const list = byGroup.get(g) ?? [];
    list.push(d);
    byGroup.set(g, list);
  }
  for (const [g, list] of byGroup) {
    console.log(`■ ${g}  (${list.length}건)`);
    for (const d of list) {
      console.log(
        `   - user=${d.userId} [${CAT_LABEL[d.category] ?? d.category}] ${d.kind} · 선택=${d.selectedMaster ?? "∅"} · 배정=${d.assignedMaster ?? "∅"}`,
      );
    }
  }
  if (drifts.length === 0) console.log("불일치 0건 — 백필 불필요.");

  // 백필 대상(개설 취소→재개설) 후보 = mismatch 가 존재하는 (org,week,team) 집합.
  const backfillTeams = new Set(mismatch.map((d) => `${d.org}::${d.weekId}::${d.teamId}`));
  console.log(`\n[백필 후보] 선택≠배정이 있는 팀·주차: ${backfillTeams.size}건`);
  for (const t of backfillTeams) {
    const [org, week, team] = t.split("::");
    console.log(`   - ${org} · week=${week} · team=${team}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
