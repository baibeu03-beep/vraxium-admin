// 검증: 실무 경험 [팀 총괄] 라인명 트리거 표시 — 셀 selected_line_id 부재 시 실제 배정·개설 라인 fallback.
//   실행: npx tsx --env-file=.env.local scripts/verify-team-overall-line-display.ts
//
// GET 라우트와 동일 경로(getTeamOverallBoard(..., resolveAssignedLineFallback=true))를 operating/test 로
// 실행하고, 각 셀의 트리거 라벨을 ExperienceLineSelect 와 동일 규칙으로 해석해 다음을 검증한다.
//   §3/§6 실제 배정 라인 → 라인명 표시(placeholder 아님)      §4 저장 selected_line_id 우선(fallback 미덮음)
//   §7 operating == test 동일 selectedLineId/라인명            §8 org 무관 동일 로직(여러 org 순회)
//   회귀: fallback OFF(개설 경로 동일)에서 있던 값은 ON 에서 그대로 유지(값 소실 0).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { EXPERIENCE_OVERALL_CATEGORIES } from "@/lib/experienceTeamOverallTypes";
import type { PartInputLineOption } from "@/lib/experiencePartInputTypes";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ExperienceLineSelect 트리거 라벨 해석과 동일: 값 없으면 "라인명", 옵션 있으면 라인명, 없으면 raw id.
function triggerLabel(value: string | null, options: PartInputLineOption[]): string {
  if (!value) return "라인명";
  const opt = options.find((o) => o.id === value);
  return opt ? opt.lineName : value; // raw id = 옵션 밖(비정상)
}

async function main() {
  // 개설(opened) + 실제 experience 라인/대상자가 있는 (org, week, team) 을 SoT(line_targets)에서 찾는다.
  const { data: overalls } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("organization_slug,week_id,team_id,status")
    .eq("status", "opened")
    .limit(50);

  const targets: Array<{ org: string; week: string; team: string; teamName: string }> = [];
  for (const o of (overalls ?? []) as Array<{ organization_slug: string; week_id: string; team_id: string }>) {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines").select("id").eq("part_type", "experience").eq("team_id", o.team_id).eq("is_active", true);
    const lineIds = (lines ?? []).map((l) => (l as { id: string }).id);
    if (lineIds.length === 0) continue;
    const { count } = await supabaseAdmin
      .from("cluster4_line_targets").select("*", { count: "exact", head: true })
      .in("line_id", lineIds).eq("week_id", o.week_id);
    if (!count) continue;
    const { data: teamRow } = await supabaseAdmin.from("cluster4_teams").select("team_name").eq("id", o.team_id).maybeSingle();
    targets.push({ org: o.organization_slug, week: o.week_id, team: o.team_id, teamName: (teamRow as { team_name: string } | null)?.team_name ?? "" });
  }
  // §4 를 non-trivial 로 만들 저장값(part_submission_cells.selected_line_id) 있는 팀도 확보.
  const { data: storedCells } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("submission_id")
    .not("selected_line_id", "is", null)
    .limit(50);
  const storedSubIds = Array.from(new Set((storedCells ?? []).map((c) => (c as { submission_id: string }).submission_id)));
  const { data: storedHeaders } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("organization_slug,week_id,team_id")
    .in("id", storedSubIds.length ? storedSubIds : ["x"]);
  for (const h of (storedHeaders ?? []) as Array<{ organization_slug: string; week_id: string; team_id: string }>) {
    if (targets.some((t) => t.org === h.organization_slug && t.week === h.week_id && t.team === h.team_id)) continue;
    const { data: teamRow } = await supabaseAdmin.from("cluster4_teams").select("team_name").eq("id", h.team_id).maybeSingle();
    targets.push({ org: h.organization_slug, week: h.week_id, team: h.team_id, teamName: (teamRow as { team_name: string } | null)?.team_name ?? "" });
  }

  // org 다양성 확보(§8) — org별 최소 1팀 + 저장값 있는 팀(§4)을 반드시 포함.
  const byOrg = new Map<string, (typeof targets)[number]>();
  for (const t of targets) if (!byOrg.has(t.org)) byOrg.set(t.org, t);
  const withStored = targets.filter((t) => (storedHeaders ?? []).some((h) => h.organization_slug === t.org && h.week_id === t.week && h.team_id === t.team));
  const scenarios = Array.from(new Map([...byOrg.values(), ...withStored].map((s) => [`${s.org}|${s.week}|${s.team}`, s])).values());
  console.log(`검증 대상 팀(개설·라인 존재, org별): ${scenarios.map((s) => `${s.org}/${s.teamName}`).join(", ")}\n`);
  if (scenarios.length === 0) { console.log("대상 없음 — 종료"); return; }

  for (const s of scenarios) {
    console.log(`\n===== [${s.org}] ${s.teamName} =====`);
    const opBoard = await getTeamOverallBoard(s.org, s.week, s.team, s.teamName, "operating", true);
    const testBoard = await getTeamOverallBoard(s.org, s.week, s.team, s.teamName, "test", true);
    const offBoard = await getTeamOverallBoard(s.org, s.week, s.team, s.teamName, "operating", false); // 개설 경로와 동일(fallback off)

    const flat = (b: typeof opBoard) => {
      const m = new Map<string, { sel: string | null; label: string }>();
      for (const p of b.parts) for (const c of p.crews) for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
        const sel = c.cells[cat.key]?.selectedLineId ?? null;
        m.set(`${c.userId}::${cat.key}`, { sel, label: triggerLabel(sel, b.lineOptions[cat.key] ?? []) });
      }
      return m;
    };
    const op = flat(opBoard), test = flat(testBoard), off = flat(offBoard);

    // §3/§6: 실제 배정 라인이 있는 셀은 라인명(placeholder 아님) 표시.
    let assigned = 0, shownName = 0, rawId = 0;
    for (const [, v] of op) {
      if (!v.sel) continue;
      assigned++;
      if (v.label === "라인명") continue;
      if (v.label === v.sel) rawId++; else shownName++;
    }
    check(`배정 라인 셀 전부 라인명 표시(placeholder/rawId 0)`, assigned > 0 && shownName === assigned && rawId === 0,
      `배정 ${assigned} · 라인명 ${shownName} · rawId ${rawId}`);

    // §7: operating == test (동일 selectedLineId & 라인명).
    let modeMismatch = 0;
    for (const [k, v] of op) {
      const tv = test.get(k);
      if (!tv || tv.sel !== v.sel || tv.label !== v.label) modeMismatch++;
    }
    check(`operating == test(셀별 selectedLineId·라인명 동일)`, modeMismatch === 0, `불일치 ${modeMismatch}`);

    // §4 + 회귀: fallback OFF 에서 값이 있던 셀은 ON 에서 동일 값 유지(덮어쓰기·소실 0).
    let overridden = 0, lost = 0;
    for (const [k, v] of off) {
      if (!v.sel) continue;
      const on = op.get(k);
      if (!on || on.sel == null) lost++;
      else if (on.sel !== v.sel) overridden++;
    }
    check(`저장 selected_line_id 보존(fallback 미덮음·소실 0)`, overridden === 0 && lost === 0, `덮음 ${overridden} · 소실 ${lost}`);

    const filledByFallback = Array.from(op.values()).filter((v) => v.sel).length - Array.from(off.values()).filter((v) => v.sel).length;
    console.log(`  fallback 로 새로 채운 셀: ${filledByFallback} (OFF sel=${Array.from(off.values()).filter((v) => v.sel).length} → ON sel=${Array.from(op.values()).filter((v) => v.sel).length})`);
  }

  console.log(failures === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("verify 오류:", e); process.exit(1); });
