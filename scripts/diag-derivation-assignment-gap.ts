/**
 * diag-derivation-assignment-gap.ts  (READ-ONLY — write 0)
 * 음료(T) W13 도출(EXOK-EN0002) 배정 누락 조사 + 보정 계획 근거.
 * 실행: npx tsx --env-file=.env.local scripts/diag-derivation-assignment-gap.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "oranke";

async function main() {
  // 대상 팀총괄(W13).
  const { data: h } = await sb.from("cluster4_experience_team_overall").select("id,week_id,team_id").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  const { week_id: weekId, team_id: teamId } = h as any;
  const teamName = (await sb.from("cluster4_teams").select("team_name").eq("id", teamId).maybeSingle()).data?.team_name;
  const wk = (await sb.from("weeks").select("week_number,start_date,season_key").eq("id", weekId).maybeSingle()).data as any;
  console.log(`대상: ${teamName}(${teamId.slice(0, 8)}) ${wk.season_key} W${wk.week_number} (${weekId})\n`);

  // 이름 맵.
  const nameOf = async (ids: string[]) => {
    const { data } = await sb.from("user_profiles").select("user_id,display_name").in("user_id", ids.length ? ids : ["x"]);
    return new Map((data ?? []).map((p: any) => [p.user_id, p.display_name]));
  };

  // 카테고리별 개설 라인 + 타깃.
  const cats = [
    { key: "derivation", code: "EXOK-EN0002", label: "도출" },
    { key: "analysis", code: "EXOK-EN0003", label: "분석" },
    { key: "evaluation", code: "EXOK-EN0004", label: "견문" },
  ];
  const targetsByCat: Record<string, Set<string>> = {};
  let derivationLineId: string | null = null;
  for (const c of cats) {
    const { data: line } = await sb.from("cluster4_lines").select("id").eq("line_code", c.code).eq("team_id", teamId).eq("part_type", "experience").eq("is_active", true).maybeSingle();
    const lineId = (line as any)?.id ?? null;
    if (c.key === "derivation") derivationLineId = lineId;
    const { data: t } = lineId ? await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", lineId).eq("week_id", weekId) : { data: [] };
    targetsByCat[c.key] = new Set((t ?? []).map((x: any) => x.target_user_id));
    console.log(`[1·2] ${c.label}(${c.code}) lineId=${lineId?.slice(0, 8) ?? "없음"} targets=${targetsByCat[c.key].size}`);
  }

  // [3·5] 분석∪견문 대상인데 도출 누락.
  const analysisOrEval = new Set([...targetsByCat.analysis, ...targetsByCat.evaluation]);
  const missingDerivation = [...analysisOrEval].filter((u) => !targetsByCat.derivation.has(u));
  const nm = await nameOf([...analysisOrEval, ...targetsByCat.derivation]);
  console.log(`\n[3·5] 분석/견문 대상이나 도출 미배정 = ${missingDerivation.length}명:`);
  for (const u of missingDerivation) console.log(`    ${nm.get(u) ?? u} (${u.slice(0, 8)})`);

  // [4] 누락 기준 — 파트 신청 셀(도출 checked/score) 대조.
  const { data: subHeaders } = await sb.from("cluster4_experience_part_submissions").select("id,part_name").eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", teamId);
  const subIds = (subHeaders ?? []).map((s: any) => s.id);
  const { data: cells } = await sb.from("cluster4_experience_part_submission_cells").select("crew_user_id,line_type,checked,score").in("submission_id", subIds.length ? subIds : ["x"]);
  const cellMap = new Map<string, { checked: boolean; score: number }>();
  for (const c of (cells ?? []) as any[]) cellMap.set(`${c.crew_user_id}::${c.line_type}`, { checked: c.checked, score: c.score });
  console.log(`\n[4] 누락자 파트신청 셀(도출/분석/견문 checked·score):`);
  console.log(`    파트 신청 헤더: ${(subHeaders ?? []).map((s: any) => s.part_name).join(", ") || "없음"}`);
  for (const u of missingDerivation) {
    const d = cellMap.get(`${u}::derivation`);
    const a = cellMap.get(`${u}::analysis`);
    const e = cellMap.get(`${u}::evaluation`);
    console.log(`    ${nm.get(u) ?? u}: 도출=${d ? `checked=${d.checked}/score=${d.score}` : "셀없음(기본 checked=true/7)"} | 분석=${a ? `${a.checked}/${a.score}` : "기본"} | 견문=${e ? `${e.checked}/${e.score}` : "기본"}`);
  }

  // [7] 기존 도출 타깃의 evaluation 존재 여부.
  if (derivationLineId) {
    const { data: dt } = await sb.from("cluster4_line_targets").select("id,target_user_id").eq("line_id", derivationLineId).eq("week_id", weekId);
    const dtIds = (dt ?? []).map((x: any) => x.id);
    const { data: evals } = await sb.from("cluster4_experience_line_evaluations").select("line_target_id,rating").in("line_target_id", dtIds.length ? dtIds : ["x"]);
    console.log(`\n[7] 기존 도출 타깃 ${dtIds.length}개 중 evaluation row = ${(evals ?? []).length}개 (배정 시 eval 동반 생성됨)`);
  }

  // [9] 음료(T) 전 타깃 테스트유저 여부.
  const allTargetUsers = Array.from(new Set([...targetsByCat.derivation, ...analysisOrEval, ...missingDerivation]));
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", allTargetUsers);
  const testCount = (markers ?? []).length;
  console.log(`\n[9] 대상 유저 ${allTargetUsers.length}명 중 테스트유저 ${testCount} / 실유저 ${allTargetUsers.length - testCount}`);

  // [8] snapshot stale 대상 = 도출 신규 배정자.
  console.log(`\n[8] 보정 시 snapshot stale 대상 = ${missingDerivation.length}명(도출 신규 배정자)`);

  console.log(`\n=== 보정 계획 근거 ===`);
  console.log(`  · EXOK-EN0002 도출 라인: 이미 개설됨(lineId=${derivationLineId?.slice(0, 8)}) → [6] target만 추가하면 됨(라인 재생성 불필요)`);
  console.log(`  · [7] line_target + evaluation(rating=도출 셀 score) 동반 생성 필요(기존 타깃과 동일 구조)`);
  console.log(`  · 누락 ${missingDerivation.length}명 = 분석/견문은 받았으나 도출 미배정. 셀 기준으로 의도(미체크=fail) vs 사고 판별 위 표 참조.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
