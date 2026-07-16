/* eslint-disable @typescript-eslint/no-explicit-any */
// READ-ONLY dry-run: phalanx w=496656d0 team=13e60f37 도출 오염 5건 정정 영향 분석.
//   cancel→reopen vs 최소 target 재배치 두 경로의 데이터 영향(라인/타깃/평가/제출/포인트/스냅샷/이력)을
//   실제 원장으로 계량한다. write 0.
//   run: npx tsx --env-file=.env.local scripts/dryrun-experience-line-correction.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";

const ORG = "phalanx";
const WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";
const TEAM = "13e60f37-152c-4e53-8d65-f633cc48d81c";

const KO_TO_CAT: Record<string, string> = { 도출: "derivation", 분석: "analysis", 평가: "evaluation", 확장: "extension", 관리: "management" };

async function main() {
  // master → category + reg(line_code/line_name) 맵.
  const { data: regs } = await supabaseAdmin
    .from("line_registrations")
    .select("line_type,bridged_master_id,line_code,line_name,is_active,organization_slug")
    .eq("hub", "experience")
    .not("bridged_master_id", "is", null);
  const masterCat = new Map<string, string>();
  const masterReg = new Map<string, { code: string; name: string; active: boolean; org: string | null }>();
  for (const r of (regs ?? []) as any[]) {
    const cat = KO_TO_CAT[r.line_type];
    if (cat) masterCat.set(r.bridged_master_id, cat);
    masterReg.set(r.bridged_master_id, { code: r.line_code, name: r.line_name, active: r.is_active, org: r.organization_slug });
  }
  const mName = async (m: string | null) => (m ? `${masterReg.get(m)?.code ?? "?"}/${masterReg.get(m)?.name ?? "?"}` : "∅");

  // 1) 이 팀 experience 라인 + 이 주차 타깃 + 평가.
  const { data: teamLines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,experience_line_master_id,line_code,main_title,is_active,team_id")
    .eq("part_type", "experience").eq("team_id", TEAM);
  const lineById = new Map<string, any>();
  for (const l of (teamLines ?? []) as any[]) lineById.set(l.id, l);
  const lineIds = Array.from(lineById.keys());

  const { data: tgts } = lineIds.length
    ? await supabaseAdmin.from("cluster4_line_targets").select("id,line_id,target_user_id,week_id").in("line_id", lineIds).eq("week_id", WEEK)
    : { data: [] as any[] };
  const targets = (tgts ?? []) as any[];
  const tgtIds = targets.map((t) => t.id);
  const { data: evals } = tgtIds.length
    ? await supabaseAdmin.from("cluster4_experience_line_evaluations").select("id,line_target_id,user_id,rating").in("line_target_id", tgtIds)
    : { data: [] as any[] };
  const evalByTgt = new Map<string, any>();
  for (const e of (evals ?? []) as any[]) evalByTgt.set(e.line_target_id, e);

  // 2) 셀 selected_line_id (도출/분석/견문 + 관리/확장).
  const selByUserCat = new Map<string, string | null>();
  const { data: pH } = await supabaseAdmin.from("cluster4_experience_part_submissions").select("id").eq("organization_slug", ORG).eq("week_id", WEEK).eq("team_id", TEAM);
  const pIds = ((pH ?? []) as any[]).map((r) => r.id);
  if (pIds.length) {
    const { data: pc } = await supabaseAdmin.from("cluster4_experience_part_submission_cells").select("crew_user_id,line_type,selected_line_id,checked,score").in("submission_id", pIds);
    for (const c of (pc ?? []) as any[]) selByUserCat.set(`${c.crew_user_id}::${c.line_type}`, c.checked && c.score > 0 ? c.selected_line_id : null);
  }
  const { data: oH } = await supabaseAdmin.from("cluster4_experience_team_overall").select("id,status").eq("organization_slug", ORG).eq("week_id", WEEK).eq("team_id", TEAM).maybeSingle();
  const overallId = (oH as any)?.id ?? null;
  if (overallId) {
    const { data: oc } = await supabaseAdmin.from("cluster4_experience_team_overall_cells").select("crew_user_id,category,selected_line_id,checked,score").eq("overall_id", overallId);
    for (const c of (oc ?? []) as any[]) selByUserCat.set(`${c.crew_user_id}::${c.category}`, c.checked && c.score > 0 ? c.selected_line_id : null);
  }

  // 3) 전체 상태 요약.
  console.log(`=== phalanx w=${WEEK.slice(0,8)} team=${TEAM.slice(0,8)} 현재 상태 ===`);
  console.log(`experience 라인(팀): ${lineIds.length}`);
  for (const l of lineById.values()) {
    const cat = masterCat.get(l.experience_line_master_id) ?? "?";
    const tc = targets.filter((t) => t.line_id === l.id).length;
    console.log(`  line ${l.id.slice(0,8)} [${cat}] master=${(l.experience_line_master_id ?? "∅").slice(0,8)} code=${l.line_code} active=${l.is_active} targets(this week)=${tc}`);
  }
  console.log(`이 주차 타깃: ${targets.length} · 평가: ${(evals ?? []).length}`);

  // 4) 도출 오염(선택≠배정) 식별.
  const mismatches: Array<{ user: string; sel: string; assignedLine: string; assignedMaster: string; tgtId: string; rating: number | null }> = [];
  for (const t of targets) {
    const line = lineById.get(t.line_id);
    const cat = masterCat.get(line?.experience_line_master_id);
    if (cat !== "derivation") continue;
    const sel = selByUserCat.get(`${t.target_user_id}::derivation`) ?? null;
    const assignedMaster = line?.experience_line_master_id ?? null;
    if (sel && assignedMaster && sel !== assignedMaster) {
      mismatches.push({ user: t.target_user_id, sel, assignedLine: t.line_id, assignedMaster, tgtId: t.id, rating: evalByTgt.get(t.id)?.rating ?? null });
    }
  }
  console.log(`\n=== 도출 오염(선택≠배정): ${mismatches.length}명 ===`);
  for (const m of mismatches) {
    console.log(`  user=${m.user.slice(0,8)} tgt=${m.tgtId.slice(0,8)} rating=${m.rating}`);
    console.log(`     선택 = ${await mName(m.sel)}`);
    console.log(`     배정 = ${await mName(m.assignedMaster)}  (line ${m.assignedLine.slice(0,8)})`);
  }

  // 5) 포인트 원장(source='line') — 오염 5명, 이 팀 라인들.
  const users = mismatches.map((m) => m.user);
  const { data: awards } = users.length
    ? await supabaseAdmin.from("process_point_awards").select("user_id,ref_id,source,point_check,point_advantage,cancelled_at,year,week_number").eq("source", "line").in("user_id", users)
    : { data: [] as any[] };
  const awardRows = (awards ?? []) as any[];
  // 이 팀 라인에 대한 award 만.
  const teamLineSet = new Set(lineIds);
  const relAwards = awardRows.filter((a) => teamLineSet.has(a.ref_id));
  console.log(`\n=== 포인트 원장(source='line', 오염5명, 이 팀 라인) ===`);
  for (const a of relAwards) {
    console.log(`  user=${a.user_id.slice(0,8)} ref_line=${a.ref_id.slice(0,8)} A=${a.point_check} B=${a.point_advantage} cancelled=${a.cancelled_at ? "Y" : "N"}`);
  }
  const activeAwardSum = relAwards.filter((a) => !a.cancelled_at).reduce((s, a) => s + (a.point_check ?? 0) + (a.point_advantage ?? 0), 0);
  console.log(`  활성 지급 합(A+B): ${activeAwardSum}`);

  // 6) 강화 결과(카드 SoT) — 오염 5명.
  console.log(`\n=== 강화 결과(카드 enhancementStatus, 이 주차 experience 도출) ===`);
  for (const u of users) {
    const r = await resolveCrewWeekCard(u, WEEK);
    if (!r.ok) { console.log(`  user=${u.slice(0,8)} 카드 없음(${r.reason})`); continue; }
    const dl = r.card.lines.filter((l: any) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId);
    for (const l of dl) console.log(`  user=${u.slice(0,8)} line=${(l.lineId as string).slice(0,8)} master=${(l.experienceLineMasterId ?? "∅").slice(0,8)} status=${l.enhancementStatus} name=${l.lineName}`);
  }

  // 7) 정정 대상 = 선택 master 별로 필요한 라인.
  const neededMasters = Array.from(new Set(mismatches.map((m) => m.sel)));
  console.log(`\n=== 정정 필요 라인(선택 master) ===`);
  for (const m of neededMasters) {
    const exists = Array.from(lineById.values()).find((l) => l.experience_line_master_id === m);
    console.log(`  master ${await mName(m)} → 기존 라인 ${exists ? exists.id.slice(0,8) : "없음(신규 생성 필요)"} · 대상 ${mismatches.filter((x) => x.sel === m).length}명`);
  }

  // 8) opened_lines 추적 + 로그.
  if (overallId) {
    const { data: ol } = await supabaseAdmin.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", overallId);
    console.log(`\nopened_lines 추적: ${((ol ?? []) as any[]).length}행 (status=${(oH as any)?.status})`);
  }

  // ── 시뮬레이션 ──
  console.log(`\n════ 경로 A: cancel→reopen ════`);
  console.log(`  삭제: 이 팀 라인 ${lineIds.length}개 + 타깃 ${targets.length} + 평가 ${(evals ?? []).length} (전 카테고리 churn)`);
  console.log(`  포인트: rollbackLines 는 지급 유지 → 삭제된 라인 ref 의 active award ${relAwards.filter((a) => !a.cancelled_at).length}건이 고아로 남음(cancelled_at=null).`);
  console.log(`  reopen: 새 라인 id 로 award 재생성 → 고아 award + 신규 award 동시 활성 = 중복 지급 위험(합=${activeAwardSum}×2 근접).`);
  console.log(`  ⚠ 평가/제출도 재생성되어 evaluated_by/at·기존 타깃 id 소멸(이력 단절).`);

  console.log(`\n════ 경로 B: 최소 target 재배치(권장) ════`);
  console.log(`  1) 선택 master ${neededMasters.length}종에 대해 이 팀/주차 라인 find-or-create(openTeamOverall 라인 생성과 동일 필드).`);
  console.log(`  2) 오염 ${mismatches.length}개 타깃의 line_id 만 UPDATE(타깃 id 불변 → 평가 line_target_id 유지·rating 보존·재삽입 없음).`);
  console.log(`  3) 포인트 정합: 옮긴 라인(구 3faf60a7) award 는 그 사용자 카드에서 사라지므로 명시 회수(soft-cancel),`);
  console.log(`     새 라인 award 는 reconcileLineAwardsForWeek(해당 5명)로 결과 기반 지급 → 라인당 upsert 멱등, 중복 0.`);
  console.log(`  4) snapshot 은 5명만 재계산. 제출 데이터(cluster4_line_submissions)는 건드리지 않음.`);
  console.log(`  영향: 평가 0삭제(유지) · 타깃 0삭제(line_id만 변경) · 포인트 순증감 없음(구 라인 회수=신 라인 지급, 동일 강화결과).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
