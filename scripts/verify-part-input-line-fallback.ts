// 검증: 개별 파트 그리드(part-input GET)의 라인명 표시 fallback — 팀 총괄과 동일 helper 공유.
//   실행: npx tsx --env-file=.env.local scripts/verify-part-input-line-fallback.ts
//   part-input GET 라우트의 특정-파트 분기 로직을 그대로 재현(getPartSubmission + assigned fallback)해
//   §3/§6 셀 selected_line_id 없어도 실제 배정 라인명 표시 · §4 저장값 우선(미덮음) · §7 op==test 검증.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getPartSubmission } from "@/lib/adminExperiencePartInput";
import {
  buildLineIdCategoryMap,
  listExperienceLineOptions,
} from "@/lib/adminExperienceLineData";
import { loadOpenedLineMasterByUserCategory } from "@/lib/adminExperienceTeamOverall";
import type { ScopeMode } from "@/lib/userScope";

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { if (!ok) fail++; console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

// part-input GET 특정-파트 분기의 cells 결정(라우트와 동일).
async function resolveCells(org: string, weekId: string, teamId: string, part: string) {
  const [sub, lineOptions] = await Promise.all([
    getPartSubmission(org, weekId, teamId, part),
    listExperienceLineOptions(org),
  ]);
  let cells = sub.cells;
  if (weekId && teamId && sub.cells.length > 0) {
    const assigned = await loadOpenedLineMasterByUserCategory(weekId, teamId, buildLineIdCategoryMap(lineOptions));
    if (assigned.size > 0) {
      cells = sub.cells.map((c) => c.selectedLineId ? c : (assigned.get(`${c.crewUserId}::${c.lineType}`) ? { ...c, selectedLineId: assigned.get(`${c.crewUserId}::${c.lineType}`)! } : c));
    }
  }
  const optIds = new Set(Object.values(lineOptions).flat().map((o) => o.id));
  return { rawCells: sub.cells, cells, optIds };
}

async function main() {
  // 개설(opened) 팀 + 파트 신청이 있는 (org, week, team, part) 수집.
  const { data: overalls } = await supabaseAdmin
    .from("cluster4_experience_team_overall").select("organization_slug,week_id,team_id").eq("status", "opened").limit(50);
  const seen = new Set<string>();
  let scenarios = 0, filledTotal = 0;
  for (const o of (overalls ?? []) as Array<{ organization_slug: string; week_id: string; team_id: string }>) {
    const { data: subs } = await supabaseAdmin
      .from("cluster4_experience_part_submissions").select("part_name")
      .eq("organization_slug", o.organization_slug).eq("week_id", o.week_id).eq("team_id", o.team_id);
    for (const s of (subs ?? []) as Array<{ part_name: string }>) {
      const key = `${o.organization_slug}|${o.week_id}|${o.team_id}|${s.part_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const op = await resolveCells(o.organization_slug, o.week_id, o.team_id, s.part_name);
      const test = await resolveCells(o.organization_slug, o.week_id, o.team_id, s.part_name); // 모드 무관(GET 표시)
      if (op.cells.length === 0) continue;
      scenarios++;

      // §4: 저장값(rawCells.selectedLineId) 있는 셀은 그대로 유지.
      const rawSel = new Map(op.rawCells.filter((c) => c.selectedLineId).map((c) => [`${c.crewUserId}:${c.lineType}`, c.selectedLineId]));
      let overridden = 0;
      for (const c of op.cells) { const k = `${c.crewUserId}:${c.lineType}`; if (rawSel.has(k) && c.selectedLineId !== rawSel.get(k)) overridden++; }

      // §3: 채워진 값은 옵션에 존재(라인명 해석 가능).
      let filled = 0, notInOpt = 0;
      for (const c of op.cells) {
        const wasNull = !rawSel.has(`${c.crewUserId}:${c.lineType}`);
        if (wasNull && c.selectedLineId) { filled++; if (!op.optIds.has(c.selectedLineId)) notInOpt++; }
      }
      filledTotal += filled;

      // §7: op==test 동일.
      const eq = op.cells.length === test.cells.length && op.cells.every((c, i) => c.selectedLineId === test.cells[i].selectedLineId);

      if (filled > 0 || overridden > 0) {
        console.log(`[${o.organization_slug}/${s.part_name}] 셀 ${op.cells.length} · fallback채움 ${filled} · 덮음 ${overridden} · 옵션밖 ${notInOpt} · op==test ${eq}`);
      }
      ck(`[${o.organization_slug}/${s.part_name}] 저장값 미덮음·채운값 옵션포함·op==test`, overridden === 0 && notInOpt === 0 && eq, `덮음${overridden} 옵션밖${notInOpt}`);
    }
  }
  console.log(`\n시나리오 ${scenarios} · fallback 로 채운 셀 합계 ${filledTotal}`);
  console.log(fail === 0 ? "✅ 전체 통과" : `❌ 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
