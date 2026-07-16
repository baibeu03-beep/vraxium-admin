/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
// 운영 정정(최소 target 재배치): phalanx w1(496656d0) team(13e60f37) 도출 오염 5명 →
//   각자 선택 라인으로 재배치. cancel→reopen 미사용(중복지급/이력단절 방지).
//   방식: 선택 master 별 라인 find-or-create(기존 도출 라인 클론) → 오염 타깃 line_id UPDATE(타깃 id 불변
//   → 평가/rating 보존) → recomputeDerivedAfterActMutation(snapshot/uws/성장/품계, 라인 지급 없음).
//   포인트 무영향(w1 experience 라인 지급 원장 0건 — 팀 전원 미지급 상태 유지, 중복/손실 0).
//   idempotent: 이미 올바른 타깃은 건너뜀. --apply 없으면 dry(변경 안 함).
//   run:  npx tsx --env-file=.env.local scripts/fix-experience-line-selection-w1-phalanx.ts --apply
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { listExperienceOverallLineOptions } from "@/lib/adminExperienceLineData";

const APPLY = process.argv.includes("--apply");
const ORG = "phalanx";
const WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";
const TEAM = "13e60f37-152c-4e53-8d65-f633cc48d81c";

async function regFor(masterId: string) {
  const { data } = await supabaseAdmin
    .from("line_registrations")
    .select("line_code,line_name,main_title,main_title_mode,output_images,output_links")
    .eq("hub", "experience").eq("bridged_master_id", masterId)
    .or(`organization_slug.is.null,organization_slug.eq.${ORG}`)
    .order("line_code", { ascending: true }).limit(1).maybeSingle();
  const r = data as any;
  if (!r) return null;
  const mainTitle = r.main_title_mode === "fixed" && r.main_title?.trim() && r.main_title.trim() !== "-" ? r.main_title.trim() : r.line_name;
  return { lineCode: r.line_code as string, lineName: r.line_name as string, mainTitle: mainTitle as string };
}

async function snapshotState(u: string) {
  const cards = await getCards(u);
  const card = cards.find((c: any) => c.weekId === WEEK);
  const dl = (card?.lines ?? []).filter((l: any) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId);
  return dl.map((l: any) => ({ lineId: l.lineId, master: l.experienceLineMasterId, name: l.lineName, status: l.enhancementStatus }));
}
async function getCards(u: string) {
  const { getCluster4WeeklyCardsForProfileUser } = await import("@/lib/cluster4WeeklyCardsData");
  return getCluster4WeeklyCardsForProfileUser(u);
}
async function w1ExpAwardSum(users: string[]) {
  // 이 팀 experience 라인(w1 타깃 보유) ref 의 활성 지급 합.
  const { data: teamLines } = await supabaseAdmin.from("cluster4_lines").select("id").eq("part_type","experience").eq("team_id",TEAM);
  const lineIds = ((teamLines ?? []) as any[]).map(l=>l.id);
  const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("line_id").in("line_id", lineIds).eq("week_id", WEEK);
  const w1LineIds = new Set(((tg ?? []) as any[]).map(t=>t.line_id));
  if (w1LineIds.size===0) return 0;
  const { data: aw } = await supabaseAdmin.from("process_point_awards").select("point_check,point_advantage,cancelled_at,ref_id,user_id").eq("source","line").in("user_id", users).in("ref_id", Array.from(w1LineIds));
  return ((aw ?? []) as any[]).filter(a=>!a.cancelled_at).reduce((s,a)=>s+(a.point_check??0)+(a.point_advantage??0),0);
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY(운영 변경)" : "DRY(변경 없음)"}\n`);

  // 0) 도출 master 집합(SoT=옵션 원천) — 분석(EN0005)/견문(EN0006)과 구분(라인코드 접두사 오매칭 방지).
  const derivMasterSet = new Set((await listExperienceOverallLineOptions(ORG)).derivation.map((o) => o.id));

  // 1) 셀 선택(도출) 로드.
  const { data: pH } = await supabaseAdmin.from("cluster4_experience_part_submissions").select("id").eq("organization_slug",ORG).eq("week_id",WEEK).eq("team_id",TEAM);
  const pIds = ((pH ?? []) as any[]).map(r=>r.id);
  const selDeriv = new Map<string,string|null>();
  if (pIds.length) {
    const { data: pc } = await supabaseAdmin.from("cluster4_experience_part_submission_cells").select("crew_user_id,line_type,selected_line_id,checked,score").in("submission_id",pIds).eq("line_type","derivation");
    for (const c of (pc ?? []) as any[]) selDeriv.set(c.crew_user_id, c.checked && c.score>0 ? c.selected_line_id : null);
  }

  // 2) 이 팀 도출 라인 + w1 타깃.
  const { data: teamLines } = await supabaseAdmin.from("cluster4_lines").select("*").eq("part_type","experience").eq("team_id",TEAM);
  const lineById = new Map<string,any>(); for (const l of (teamLines ?? []) as any[]) lineById.set(l.id, l);
  const derivLineByMaster = new Map<string,any>(); // master → line (이 팀)
  const { data: tgts } = await supabaseAdmin.from("cluster4_line_targets").select("id,line_id,target_user_id,week_id").in("line_id", Array.from(lineById.keys())).eq("week_id",WEEK);
  const targets = (tgts ?? []) as any[];

  // 도출 마스터 집합(선택값 + 등록).
  const derivMasters = new Set<string>();
  for (const v of selDeriv.values()) if (v) derivMasters.add(v);
  // 기존 도출 라인 master→line 매핑(w1 타깃 보유 라인만 우선).
  for (const t of targets) {
    const l = lineById.get(t.line_id);
    if (l && derivMasters.has(l.experience_line_master_id)) derivLineByMaster.set(l.experience_line_master_id, l);
  }
  // 클론 템플릿 = 현재 오염 타깃이 붙은 도출 라인(현재 배정 master ∈ 도출 집합).
  const templateLine = targets.map(t=>lineById.get(t.line_id)).find(l=>l && derivMasterSet.has(l.experience_line_master_id)) ?? null;

  // 3) 오염 타깃 식별(도출 라인에 배정된 타깃만: 선택 도출 master ≠ 배정 도출 master).
  type MM = { user:string; sel:string; tgtId:string; curLine:string; curMaster:string };
  const mismatches: MM[] = [];
  for (const t of targets) {
    const l = lineById.get(t.line_id);
    if (!l || !derivMasterSet.has(l.experience_line_master_id)) continue; // 도출 라인만(분석 EN0005/견문 EN0006 제외).
    const sel = selDeriv.get(t.target_user_id) ?? null;
    if (sel && l.experience_line_master_id && sel !== l.experience_line_master_id) {
      mismatches.push({ user: t.target_user_id, sel, tgtId: t.id, curLine: t.line_id, curMaster: l.experience_line_master_id });
    }
  }
  const users = Array.from(new Set(mismatches.map(m=>m.user)));
  console.log(`오염 도출 타깃: ${mismatches.length}건 / 사용자 ${users.length}명`);
  if (mismatches.length === 0) { console.log("정정 대상 없음(이미 정합) — 종료."); return; }

  // BEFORE 상태.
  console.log("\n── BEFORE ──");
  const before: Record<string, any> = {};
  for (const u of users) before[u] = await snapshotState(u);
  const evalCountBefore = (await supabaseAdmin.from("cluster4_experience_line_evaluations").select("id",{count:"exact",head:true}).in("line_target_id", mismatches.map(m=>m.tgtId))).count ?? 0;
  const awardBefore = await w1ExpAwardSum(users);
  for (const m of mismatches) console.log(`  u=${m.user.slice(0,8)} 선택=${m.sel.slice(0,8)} 현재배정=${m.curMaster.slice(0,8)}(line ${m.curLine.slice(0,8)}) card=${JSON.stringify(before[m.user])}`);
  console.log(`  평가 행(대상 타깃): ${evalCountBefore} · w1 experience 활성지급합: ${awardBefore}`);

  if (!APPLY) {
    console.log("\n[DRY] --apply 없이 종료(변경 없음). 계획:");
    const need = Array.from(new Set(mismatches.map(m=>m.sel)));
    for (const m of need) {
      const exists = derivLineByMaster.get(m);
      const reg = await regFor(m);
      console.log(`  master ${m.slice(0,8)} (${reg?.lineCode}) → ${exists ? `기존 라인 ${exists.id.slice(0,8)} 재사용` : "신규 라인 생성"} · 대상 ${mismatches.filter(x=>x.sel===m).length}명`);
    }
    return;
  }

  if (!templateLine) throw new Error("클론 템플릿(도출 EN0001) 라인을 찾지 못함 — 중단.");

  // 4) 선택 master 별 라인 find-or-create.
  const lineForMaster = new Map<string,string>();
  for (const master of Array.from(new Set(mismatches.map(m=>m.sel)))) {
    const existing = derivLineByMaster.get(master);
    if (existing) { lineForMaster.set(master, existing.id); continue; }
    const reg = await regFor(master);
    if (!reg) throw new Error(`master ${master} 등록 없음 — 중단.`);
    // 템플릿 클론(제외: id/created_at/updated_at) + master/code/main_title 교체.
    const { id: _id, created_at: _c, updated_at: _u, ...clone } = templateLine as any;
    const insert = { ...clone, experience_line_master_id: master, line_code: reg.lineCode, main_title: reg.mainTitle };
    const { data: ins, error } = await supabaseAdmin.from("cluster4_lines").insert(insert).select("id").single();
    if (error || !ins) throw new Error(`라인 생성 실패(${master}): ${error?.message}`);
    const newId = (ins as any).id;
    lineForMaster.set(master, newId);
    derivLineByMaster.set(master, { id: newId, experience_line_master_id: master });
    console.log(`  + 신규 라인 ${newId.slice(0,8)} master=${master.slice(0,8)} ${reg.lineCode}`);
    // opened_lines 추적(cancel 정합).
    const { data: oH } = await supabaseAdmin.from("cluster4_experience_team_overall").select("id").eq("organization_slug",ORG).eq("week_id",WEEK).eq("team_id",TEAM).maybeSingle();
    if ((oH as any)?.id) await supabaseAdmin.from("cluster4_experience_team_overall_opened_lines").insert({ overall_id: (oH as any).id, category: "derivation", line_id: newId });
  }

  // 5) 오염 타깃 line_id UPDATE(타깃 id 불변).
  for (const m of mismatches) {
    const dest = lineForMaster.get(m.sel)!;
    const { error } = await supabaseAdmin.from("cluster4_line_targets").update({ line_id: dest }).eq("id", m.tgtId);
    if (error) throw new Error(`타깃 이동 실패(${m.tgtId}): ${error.message}`);
    console.log(`  ↷ u=${m.user.slice(0,8)} tgt=${m.tgtId.slice(0,8)} → line ${dest.slice(0,8)}`);
  }

  // 6) 파생 재계산(지급 없음 — snapshot/uws/성장/품계).
  for (const u of users) {
    await recomputeDerivedAfterActMutation({ userId: u, weekId: WEEK }).catch((e)=>console.warn("rejudge fail", u.slice(0,8), e?.message));
    await recomputeAndStoreWeeklyCardsSnapshot(u).catch(()=>{});
  }

  // AFTER.
  console.log("\n── AFTER ──");
  const evalCountAfter = (await supabaseAdmin.from("cluster4_experience_line_evaluations").select("id",{count:"exact",head:true}).in("line_target_id", mismatches.map(m=>m.tgtId))).count ?? 0;
  const awardAfter = await w1ExpAwardSum(users);
  let ok = 0, bad = 0;
  for (const m of mismatches) {
    const after = await snapshotState(m.user);
    const match = after.find((x:any)=>x.master===m.sel);
    const good = !!match;
    console.log(`  u=${m.user.slice(0,8)} → ${good?"✓":"✗"} card master=${match?.master?.slice(0,8) ?? "∅"} name=${match?.name ?? "∅"}`);
    good ? ok++ : bad++;
  }
  console.log(`\n평가 행: ${evalCountBefore} → ${evalCountAfter} (손실 ${evalCountBefore-evalCountAfter}) · w1 지급합: ${awardBefore} → ${awardAfter} (증감 ${awardAfter-awardBefore})`);
  console.log(`정정 성공: ${ok}/${mismatches.length}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
