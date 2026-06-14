/**
 * diag-kwonyejun-assignments.ts  (READ-ONLY — write 0)
 * 권예준 W13 실무경험 라인 배정 실태 + 정책(본인 배정만 분모) 적용 시 분모 계산.
 * 실행: npx tsx --env-file=.env.local scripts/diag-kwonyejun-assignments.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const UNIFIED_CODE = "EXBS-EN260525";

async function main() {
  // 1. 권예준 식별.
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,organization_slug,role").or("display_name.ilike.%권예준%,display_name.ilike.%T권예준%");
  console.log("[권예준 후보]");
  for (const p of (profs ?? []) as any[]) console.log(`  ${p.display_name} | ${p.user_id} | org=${p.organization_slug} | role=${p.role}`);
  const me = (profs ?? [])[0] as any;
  if (!me) { console.log("권예준 프로필 없음"); return; }
  const u = me.user_id;

  // 2. membership.
  const { data: mems } = await sb.from("user_memberships").select("team_name,part_name,membership_level,membership_state,is_current").eq("user_id", u);
  const cur = (mems ?? []).find((m: any) => m.is_current) ?? (mems ?? [])[0];
  console.log(`\n[membership] team=${cur?.team_name} part=${cur?.part_name} level=${cur?.membership_level} state=${cur?.membership_state}`);
  // 팀 id.
  const teamRow = (await sb.from("cluster4_teams").select("id,team_name").eq("team_name", cur?.team_name).eq("organization_slug", me.organization_slug).maybeSingle()).data as any;
  const myTeamId = teamRow?.id;
  console.log(`  내 team_id=${myTeamId}`);

  // 대상 주차 W13.
  const { data: h } = await sb.from("cluster4_experience_team_overall").select("week_id").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  const weekId = (h as any).week_id;
  const wk = (await sb.from("weeks").select("week_number,start_date,season_key").eq("id", weekId).maybeSingle()).data as any;
  console.log(`\n[주차] ${wk?.season_key} W${wk?.week_number} ${wk?.start_date} (${weekId})`);

  // 3. 권예준 본인 배정 라인(target_user_id=나) on W13.
  const { data: myTargets } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,target_user_id, cluster4_lines!inner(line_code,part_type,team_id,experience_line_master_id,is_active)")
    .eq("week_id", weekId)
    .eq("target_user_id", u)
    .eq("cluster4_lines.part_type", "experience");
  console.log(`\n[3] 본인 배정(target_user_id=나) experience 라인 (lineTargetId 존재):`);
  for (const t of (myTargets ?? []) as any[]) {
    const l = t.cluster4_lines;
    const sameTeam = l.team_id === myTeamId;
    const isUnified = l.line_code === UNIFIED_CODE;
    console.log(`  ${l.line_code} | lineId=${t.line_id.slice(0, 8)} | targetId=${t.id.slice(0, 8)} | team=${l.team_id?.slice(0, 8)}${sameTeam ? "(내팀)" : "(타팀!)"} | ${isUnified ? "★통합" : ""} active=${l.is_active}`);
  }
  const assignedCodes = (myTargets ?? []).map((t: any) => t.cluster4_lines.line_code);

  // 정책 적용: 본인 배정 + 내팀 + 통합 제외.
  const policyLines = (myTargets ?? []).filter((t: any) => t.cluster4_lines.team_id === myTeamId && t.cluster4_lines.line_code !== UNIFIED_CODE);
  console.log(`\n[정책 적용 분모(본인배정∧내팀∧통합제외)] = ${policyLines.length}개: ${policyLines.map((t: any) => t.cluster4_lines.line_code).join(", ")}`);

  // 도출 EXOK-EN0002 배정 여부 — 사용자 기대 확인.
  const hasDerivation = assignedCodes.includes("EXOK-EN0002");
  console.log(`\n[기대 검증] 도출 EXOK-EN0002 본인 배정? ${hasDerivation ? "예" : "아니오 ← 기대(포함)와 불일치!"}`);
  console.log(`  통합(${UNIFIED_CODE}) 본인 배정? ${assignedCodes.includes(UNIFIED_CODE)} (현재 슬롯1 도출 자리)`);

  // 4. 현재 카드(mode=test) 분모 7 구성 재확인.
  const dTest = await getCluster4WeeklyCardsForProfileUser(u, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  const cTest = dTest.find((c: any) => c.weekId === weekId);
  const exp = (cTest?.lines ?? []).filter((l: any) => l.partType === "experience");
  console.log(`\n[4] 현재 mode=test 카드 experience 분모 구성 (${exp.filter((l: any) => l.enhancementStatus !== "not_applicable").length}개):`);
  for (const l of exp) {
    console.log(`  ${String(l.experienceSlotOrder ?? "-")} ${String(l.lineCode ?? "·").padEnd(13)} enh=${String(l.enhancementStatus).padEnd(11)} targetId=${l.lineTargetId ? l.lineTargetId.slice(0, 8) : "NULL(미배정)"} ${l.lineCode === UNIFIED_CODE ? "★통합" : ""}`);
  }
  const assignedInCard = exp.filter((l: any) => l.lineTargetId && l.enhancementStatus !== "not_applicable");
  const syntheticInCard = exp.filter((l: any) => !l.lineTargetId && l.enhancementStatus !== "not_applicable");
  console.log(`\n[1] 분모 중 본인배정(targetId 존재) = ${assignedInCard.length}개`);
  console.log(`[2] 분모 중 synthetic fail(targetId null) = ${syntheticInCard.length}개: ${syntheticInCard.map((l: any) => l.lineCode).join(", ")}`);

  console.log(`\n=== 정책 vs 현재 ===`);
  console.log(`  현재 분모: ${exp.filter((l: any) => l.enhancementStatus !== "not_applicable").length} (본인배정 ${assignedInCard.length} + synthetic ${syntheticInCard.length})`);
  console.log(`  정책 분모(본인배정∧내팀∧통합제외): ${policyLines.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
