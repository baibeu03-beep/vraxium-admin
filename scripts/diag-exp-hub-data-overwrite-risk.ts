// 진단(READ-ONLY) — 신규 라인 개설이 기존 실무 경험 허브 데이터를 덮어쓰는지.
//   npx tsx --env-file=.env.local scripts/diag-exp-hub-data-overwrite-risk.ts
// DB write 0. 테스트 유저(test_user_markers) 기준 기존 experience 허브 데이터 현황 조사.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

async function count(table: string, build: (q: any) => any): Promise<number> {
  const q = build(supabaseAdmin.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) { console.warn(`  [${table}] 조회 실패: ${error.message}`); return -1; }
  return count ?? 0;
}

async function main() {
  const ids = [...(await fetchTestUserMarkerIds())];
  console.log(`test_user_markers: ${ids.length}명\n`);

  // ── A. 테스트 유저 대상 기존 experience cluster4_lines(타깃 기준, 팀 무관) ──
  // line_targets.target_user_id ∈ markers → 그 line 이 experience 인지 확인.
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_user_id")
    .in("target_user_id", ids)
    .limit(5000);
  const tgtRows = (tgts ?? []) as Array<{ id: string; line_id: string; week_id: string; target_user_id: string }>;
  const lineIds = [...new Set(tgtRows.map((t) => t.line_id))];
  let expLineIds: string[] = [];
  const lineTeam = new Map<string, string | null>();
  if (lineIds.length) {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,part_type,team_id,line_code,is_active")
      .in("id", lineIds);
    for (const l of (lines ?? []) as any[]) {
      if (l.part_type === "experience") { expLineIds.push(l.id); lineTeam.set(l.id, l.team_id); }
    }
  }
  const expTgts = tgtRows.filter((t) => expLineIds.includes(t.line_id));
  console.log("── A. 테스트 유저가 타깃인 기존 experience 라인/타깃 ──");
  console.log(`  experience cluster4_lines(테스트유저 타깃): ${expLineIds.length}개`);
  console.log(`  cluster4_line_targets(테스트유저, experience): ${expTgts.length}행`);
  const expTgtIds = expTgts.map((t) => t.id);
  if (expTgtIds.length) {
    const evalCount = await count("cluster4_experience_line_evaluations", (q) => q.in("line_target_id", expTgtIds.slice(0, 1000)));
    const subCount = await count("cluster4_line_submissions", (q) => q.in("line_target_id", expTgtIds.slice(0, 1000)));
    console.log(`  → evaluations: ${evalCount}행 / line_submissions(고객 제출물): ${subCount}행`);
  }
  // 라인의 team_id 분포(테스트팀 소속인지/레거시인지).
  const teamDist = new Map<string, number>();
  for (const lid of expLineIds) { const t = lineTeam.get(lid) ?? "null"; teamDist.set(t, (teamDist.get(t) ?? 0) + 1); }
  console.log(`  experience 라인 team_id 분포: ${JSON.stringify(Object.fromEntries(teamDist))}`);

  // ── B. 테스트 유저 주차카드/성장 허브 데이터(uws/points/growth/snapshot) ──
  console.log("\n── B. 테스트 유저 주차/성장 허브 데이터 ──");
  console.log(`  user_week_statuses: ${await count("user_week_statuses", (q) => q.in("user_id", ids))}행`);
  console.log(`  user_weekly_points: ${await count("user_weekly_points", (q) => q.in("user_id", ids))}행`);
  console.log(`  user_growth_stats: ${await count("user_growth_stats", (q) => q.in("user_id", ids))}행`);
  console.log(`  cluster4_weekly_card_snapshots: ${await count("cluster4_weekly_card_snapshots", (q) => q.in("user_id", ids))}행`);

  // ── C. openTeamOverall 이 쓰는 테이블 vs 위 데이터 교집합 판정 ──
  console.log("\n── C. openTeamOverall write 대상 테이블 (코드 기준) ──");
  const writes = [
    ["cluster4_experience_team_overall", "UPSERT(헤더, org+week+team) + UPDATE(status=opened)"],
    ["cluster4_experience_team_overall_cells", "DELETE(eq overall_id=이 팀) + INSERT  ← 이 팀 검수 셀만 replace"],
    ["cluster4_experience_team_overall_outputs", "DELETE(eq overall_id=이 팀) + INSERT ← 이 팀 아웃풋만 replace"],
    ["cluster4_lines", "INSERT (카테고리당 새 row, team_id=이 팀)  ← 기존 라인 UPDATE/DELETE 없음"],
    ["cluster4_line_targets", "INSERT (새 라인의 새 타깃)"],
    ["cluster4_experience_line_evaluations", "INSERT (새 타깃의 평가)"],
    ["cluster4_experience_team_overall_opened_lines", "INSERT (추적)"],
    ["cluster4_weekly_card_snapshots", "is_stale=true 플래그만(markStaleMany) ← 파괴적 write 아님·lazy 재계산"],
  ];
  for (const [t, op] of writes) console.log(`  ${t}\n      → ${op}`);
  console.log("\n  openTeamOverall 이 절대 건드리지 않는 테이블:");
  console.log("    user_week_statuses · user_weekly_points · user_growth_stats (직접 write 없음)");
  console.log("    cluster4_line_submissions (고객 제출물) · 기존 cluster4_lines/targets/evaluations(타 라인)");
  console.log("    cluster4_experience_part_submissions/_cells (open 은 READ만)");

  console.log("\n── D. DELETE 발생 지점(파괴적) ──");
  console.log("  openTeamOverall: team_overall_cells/_outputs DELETE = 오직 '이 팀 자신의 검수 초안'만(overall_id 스코프). 허브 라인/평가 DELETE 없음.");
  console.log("  cancelTeamOverall([개설 취소]에서만): opened_lines 추적 기준으로 '이번에 개설한' lines/targets/evaluations 역순 DELETE. 기존(이전) 라인은 추적 대상 아니라 보존.");

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
