/**
 * Phase 3 blast-radius — 레거시 주차(2026 여름 W1 이전) 역량/경험 라인이 실사용자에 미치는 범위.
 *   npx tsx --env-file=.env.local scripts/diag-legacy-hub-blast-radius.ts
 *
 * 레거시 주차 카드 렌더를 바꾸면 강화율이 변하는 "실제" 범위를 수치화한다.
 *   - competency: 레거시 주차에 개설/배정된 라인·타깃(실유저/테스트 분리).
 *   - experience: [통합] 마스터 vs 비통합(granular·현재 카드 미표시)로 분리.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);
const LEGACY_BEFORE = "2026-06-29";

async function main() {
  // 통합 마스터 id.
  const { data: masters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id, line_code, line_name");
  const unified = (masters ?? []).find(
    (m: any) => /통합/.test(m.line_name ?? "") || /통합/.test(m.line_code ?? "") || (m.line_code ?? "").includes("UNIFIED"),
  );
  console.log("unified master:", unified ? { id: unified.id, code: unified.line_code, name: unified.line_name } : "NONE");
  const unifiedId = unified?.id ?? null;

  // 레거시 주차 id.
  const { data: weeks } = await sb.from("weeks").select("id").lt("start_date", LEGACY_BEFORE);
  const legacy = new Set((weeks ?? []).map((w) => w.id as string));

  // 테스트 유저.
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m) => m.user_id as string));

  const acc: Record<string, {
    lines: Set<string>;
    unifiedLines: Set<string>;
    nonUnifiedLines: Set<string>;
    realTargets: Set<string>;
    testTargets: Set<string>;
    realUsers: Set<string>;
  }> = {
    competency: { lines: new Set(), unifiedLines: new Set(), nonUnifiedLines: new Set(), realTargets: new Set(), testTargets: new Set(), realUsers: new Set() },
    experience: { lines: new Set(), unifiedLines: new Set(), nonUnifiedLines: new Set(), realTargets: new Set(), testTargets: new Set(), realUsers: new Set() },
  };

  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("cluster4_line_targets")
      .select("id, week_id, target_user_id, target_mode, cluster4_lines!inner(id, part_type, is_active, is_qa_test, experience_line_master_id)")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    for (const r of rows) {
      const line = r.cluster4_lines;
      if (!line || !line.is_active) continue;
      if (line.is_qa_test) continue; // 운영만
      if (!legacy.has(r.week_id)) continue;
      const part = line.part_type;
      if (part !== "competency" && part !== "experience") continue;
      const a = acc[part];
      a.lines.add(line.id);
      if (part === "experience") {
        if (unifiedId && line.experience_line_master_id === unifiedId) a.unifiedLines.add(line.id);
        else a.nonUnifiedLines.add(line.id);
      }
      if (r.target_mode === "user" && r.target_user_id) {
        if (testers.has(r.target_user_id)) a.testTargets.add(r.id);
        else { a.realTargets.add(r.id); a.realUsers.add(r.target_user_id); }
      }
    }
    if (rows.length < 1000) break;
    from += 1000;
  }

  for (const part of ["competency", "experience"] as const) {
    const a = acc[part];
    console.log(`\n== ${part} (레거시·운영) ==`);
    console.log(`  distinct lines: ${a.lines.size}` + (part === "experience" ? ` (통합 ${a.unifiedLines.size} / 비통합 ${a.nonUnifiedLines.size})` : ""));
    console.log(`  targets: real ${a.realTargets.size} / test ${a.testTargets.size}`);
    console.log(`  영향 실사용자(distinct): ${a.realUsers.size}`);
  }
  console.log("\n해석: experience 비통합 + competency 가 현재 카드 미표시(레거시 게이트) → Phase 3 로 표시되면");
  console.log("      해당 실사용자 레거시 주차 강화율 분모/분자가 변함. 통합 experience 는 이미 표시 중(무변).");
}

main().catch((e) => { console.error(e); process.exit(1); });
