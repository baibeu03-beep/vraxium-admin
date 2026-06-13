// 진단(READ-ONLY) — mode=test 실무 경험 라인개설 전, 테스트 팀 현 데이터 상태.
//   npx tsx --env-file=.env.local scripts/diag-exp-testteam-data-state.ts
// DB write 0. snapshot 무접촉.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOpenableWeekStartMs, describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";

const ORG = "oranke";
const TEAMS = ["과일(T)", "음료(T)", "콘텐츠실험(T)"];

async function main() {
  // 0) 개설 대상 주차(openable, 금요일 경계).
  const todayIso = new Date().toISOString().slice(0, 10);
  const ms = getOpenableWeekStartMs(todayIso);
  const info = ms != null ? describeWeekByStartMs(ms) : null;
  let openableWeekId: string | null = null;
  if (info) {
    const { data } = await supabaseAdmin.from("weeks").select("id").eq("iso_year", info.isoYear).eq("iso_week", info.isoWeek).maybeSingle();
    openableWeekId = (data as { id: string } | null)?.id ?? null;
  }
  console.log(`개설 대상 주차: ${info ? `${info.year} ${info.seasonName} W${info.weekNumber}` : "?"} (${openableWeekId})\n`);

  // 1) 팀 id 해석.
  const { data: teamRows } = await supabaseAdmin
    .from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).in("team_name", TEAMS);
  const teamById = new Map<string, string>(); // id→name
  const idByName = new Map<string, string>();
  for (const t of (teamRows ?? []) as { id: string; team_name: string }[]) { teamById.set(t.id, t.team_name); idByName.set(t.team_name, t.id); }
  const teamIds = [...teamById.keys()];
  console.log("팀 id:", Object.fromEntries(idByName));

  // 2) team_overall(헤더) — 상태/주차별.
  console.log("\n── cluster4_experience_team_overall (헤더) ──");
  const { data: overalls } = await supabaseAdmin
    .from("cluster4_experience_team_overall").select("id,team_id,week_id,status,opened_at").in("team_id", teamIds);
  const overallRows = (overalls ?? []) as any[];
  for (const o of overallRows) console.log(`  ${teamById.get(o.team_id)} week=${o.week_id===openableWeekId?"[대상]":o.week_id.slice(0,8)} status=${o.status} opened_at=${o.opened_at ?? "-"} overall_id=${o.id.slice(0,8)}`);
  if (overallRows.length === 0) console.log("  (없음)");
  const overallIds = overallRows.map((o) => o.id);

  // 3) opened_lines (개설로 생성된 라인 추적).
  console.log("\n── cluster4_experience_team_overall_opened_lines ──");
  if (overallIds.length) {
    const { data: ol } = await supabaseAdmin.from("cluster4_experience_team_overall_opened_lines").select("overall_id,category,line_id").in("overall_id", overallIds);
    const olRows = (ol ?? []) as any[];
    console.log(`  총 ${olRows.length}행`);
    for (const r of olRows) console.log(`    overall=${r.overall_id.slice(0,8)} category=${r.category} line_id=${r.line_id.slice(0,8)}`);
  } else console.log("  (overall 없음 → 0)");

  // 4) part_submissions / cells.
  console.log("\n── cluster4_experience_part_submissions ──");
  const { data: subs } = await supabaseAdmin
    .from("cluster4_experience_part_submissions").select("id,team_id,week_id,part_name").in("team_id", teamIds);
  const subRows = (subs ?? []) as any[];
  for (const s of subRows) console.log(`  ${teamById.get(s.team_id)} week=${s.week_id===openableWeekId?"[대상]":s.week_id.slice(0,8)} part=${s.part_name} sub_id=${s.id.slice(0,8)}`);
  if (subRows.length === 0) console.log("  (없음)");
  const subIds = subRows.map((s) => s.id);
  if (subIds.length) {
    const { count: cellCount } = await supabaseAdmin.from("cluster4_experience_part_submission_cells").select("*", { count: "exact", head: true }).in("submission_id", subIds);
    console.log(`  → submission_cells 총 ${cellCount ?? 0}행`);
  }

  // 5) cluster4_lines (experience, 테스트 팀) + targets + evaluations.
  console.log("\n── cluster4_lines (part_type=experience, 테스트 팀) ──");
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines").select("id,team_id,line_code,main_title,is_active,activity_type_id,created_at").eq("part_type", "experience").in("team_id", teamIds);
  const lineRows = (lines ?? []) as any[];
  console.log(`  총 ${lineRows.length}행`);
  for (const l of lineRows) console.log(`    ${teamById.get(l.team_id)} code=${l.line_code} active=${l.is_active} act_type=${l.activity_type_id ?? "NULL"} title=${(l.main_title??"").slice(0,16)} line_id=${l.id.slice(0,8)}`);
  const lineIds = lineRows.map((l) => l.id);
  if (lineIds.length) {
    const { data: tgts } = await supabaseAdmin.from("cluster4_line_targets").select("id,line_id,week_id,target_user_id").in("line_id", lineIds);
    const tgtRows = (tgts ?? []) as any[];
    console.log(`  → line_targets 총 ${tgtRows.length}행 (week 분포: ${[...new Set(tgtRows.map((t)=>t.week_id===openableWeekId?"[대상]":t.week_id.slice(0,8)))].join(",")})`);
    const tgtIds = tgtRows.map((t) => t.id);
    if (tgtIds.length) {
      const { count: evalCount } = await supabaseAdmin.from("cluster4_experience_line_evaluations").select("*", { count: "exact", head: true }).in("line_target_id", tgtIds);
      console.log(`  → evaluations 총 ${evalCount ?? 0}행`);
      const { count: subCount } = await supabaseAdmin.from("cluster4_line_submissions").select("*", { count: "exact", head: true }).in("line_target_id", tgtIds);
      console.log(`  → line_submissions(고객 제출) 총 ${subCount ?? 0}행`);
    }
  }

  // 6) 대상 주차 기준 "이미 개설됨" 여부 요약(409 위험).
  console.log("\n── 대상 주차 개설 상태 요약(openTeamOverall 409 위험) ──");
  for (const name of TEAMS) {
    const tid = idByName.get(name);
    const o = overallRows.find((x) => x.team_id === tid && x.week_id === openableWeekId);
    console.log(`  ${name}: ${o ? `status=${o.status}${o.status === "opened" ? " ⚠재개설 409 차단(취소 필요)" : " (재검수/개설 가능)"}` : "헤더 없음(신규 개설 가능)"}`);
  }

  // 7) opening_logs (최근).
  const { count: logCount } = await supabaseAdmin.from("cluster4_experience_opening_logs").select("*", { count: "exact", head: true }).eq("organization_slug", ORG);
  console.log(`\n── opening_logs (oranke) 총 ${logCount ?? 0}행 (append-only 로그·개설과 무관) ──`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
