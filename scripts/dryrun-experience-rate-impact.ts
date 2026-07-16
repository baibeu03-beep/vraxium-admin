/* eslint-disable @typescript-eslint/no-explicit-any */
// READ-ONLY: 실무경험 강화율 산식 변경 영향 분석.
//   A) 구조 스캔: (team,week,category)에 서로 다른 master 라인 ≥2 = 미배정 희석 발생 조건 →
//      영향 팀·주차 + 배정 사용자 수.
//   B) 표본 사용자: 구(전체 non-na) vs 신(본인 배정만) experience 강화율 대조.
//   C) competency/career: 동일 skip(lineId!=null && target==null non-na)이 적용될 라인이 있는지 →
//      있으면 정책 상이(보고), 없으면 무영향(동일 정책).
//   run: npx tsx --env-file=.env.local scripts/dryrun-experience-rate-impact.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const KO_TO_CAT: Record<string,string> = { 도출:"derivation", 분석:"analysis", 평가:"evaluation", 확장:"extension", 관리:"management" };

// 구/신 experience 집계(카드 lines 기준).
function expRates(lines: any[]) {
  const nonNa = lines.filter(l=>l.partType==="experience" && l.enhancementStatus!=="not_applicable");
  const legacyAvail = nonNa.length;
  const legacyComp = nonNa.filter(l=>l.enhancementStatus==="success").length;
  const assigned = nonNa.filter(l=>!(l.lineId!=null && l.lineTargetId==null)); // 신규 규칙: 미배정 제외
  const newAvail = assigned.length;
  const newComp = assigned.filter(l=>l.enhancementStatus==="success").length;
  return { legacy:`${legacyComp}/${legacyAvail}`, neo:`${newComp}/${newAvail}`, changed: legacyAvail!==newAvail };
}
function otherPartTargetNull(lines: any[], part: string) {
  return lines.filter(l=>l.partType===part && l.enhancementStatus!=="not_applicable" && l.lineId!=null && l.lineTargetId==null).length;
}

async function main() {
  // master → category.
  const { data: regs } = await supabaseAdmin.from("line_registrations").select("line_type,bridged_master_id").eq("hub","experience").not("bridged_master_id","is",null);
  const masterCat = new Map<string,string>();
  for (const r of (regs??[]) as any[]) { const c=KO_TO_CAT[r.line_type]; if(c) masterCat.set(r.bridged_master_id,c); }

  // A) 구조 스캔 — 미배정 희석은 팀 스코프 라인에서만 발생(openedFailLineDetail 이 line.team_id !==
  //   본인 팀이면 제외 → team_id=null 라인은 절대 희석 원인 아님). 팀 보유 experience 라인만 스캔.
  const { data: lines } = await supabaseAdmin.from("cluster4_lines").select("id,team_id,experience_line_master_id").eq("part_type","experience").eq("is_active",true).not("team_id","is",null);
  const lineMaster = new Map<string,{team:string|null,master:string|null}>();
  for (const l of (lines??[]) as any[]) lineMaster.set(l.id,{team:l.team_id,master:l.experience_line_master_id});
  const lineIds = Array.from(lineMaster.keys());
  // 타깃(주차별) — 팀 라인만이라 소규모(1000행 cap 무관). 라인당 개별 조회로 cap 회피.
  const targetsByLine = new Map<string, any[]>();
  for (const lineId of lineIds) {
    const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("line_id,week_id,target_user_id").eq("line_id", lineId);
    if (tg && tg.length) targetsByLine.set(lineId, tg as any[]);
  }
  // (team,week,category) → set(master), set(user).
  const groupMasters = new Map<string,Set<string>>();
  const groupUsers = new Map<string,Set<string>>();
  const bump = (m: Map<string,Set<string>>, k: string) => { let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } return s; };
  for (const [lineId, info] of lineMaster) {
    const cat = info.master ? masterCat.get(info.master) : null;
    if (!cat || !info.team) continue;
    for (const t of (targetsByLine.get(lineId)??[])) {
      const key = `${info.team}::${t.week_id}::${cat}`;
      bump(groupMasters, key).add(info.master!);
      if (t.target_user_id) bump(groupUsers, key).add(t.target_user_id);
    }
  }
  const multi = [...groupMasters.entries()].filter(([,m])=>m.size>=2);
  const affectedTeamWeeks = new Set(multi.map(([k])=>k.split("::").slice(0,2).join("::")));
  const affectedUsers = new Set<string>();
  for (const [k] of multi) for (const u of (groupUsers.get(k)??[])) affectedUsers.add(u);
  console.log(`=== A) 구조 스캔 ===`);
  console.log(`미배정 희석 발생 (team,week,category) [master≥2]: ${multi.length}건`);
  console.log(`영향 (team,week): ${affectedTeamWeeks.size} · 배정 사용자(중복제거): ${affectedUsers.size}명`);
  const byCat = new Map<string,number>();
  for (const [k] of multi) { const cat=k.split("::")[2]; byCat.set(cat,(byCat.get(cat)??0)+1); }
  console.log(`  카테고리별: ${[...byCat.entries()].map(([c,n])=>`${c}=${n}`).join(", ")}`);

  // B+C) 표본 사용자(영향 사용자 최대 12명) 카드로 구/신 대조 + competency/career 점검.
  console.log(`\n=== B) 표본 사용자 구(전체) vs 신(배정만) experience 강화율 ===`);
  const sample = [...affectedUsers].slice(0,12);
  let compCareerFlagged = 0;
  for (const u of sample) {
    let cards: any[]; try { cards = await getCluster4WeeklyCardsForProfileUser(u); } catch { continue; }
    // 영향 주차만.
    for (const card of cards) {
      const exp = expRates(card.lines);
      if (!exp.changed) continue;
      const compTN = otherPartTargetNull(card.lines,"competency");
      const carTN = otherPartTargetNull(card.lines,"career");
      if (compTN>0||carTN>0) compCareerFlagged++;
      console.log(`  u=${u.slice(0,8)} w=${card.weekId.slice(0,8)} 구=${exp.legacy} → 신=${exp.neo}${compTN||carTN?`  ⚠comp/career target-null: comp=${compTN} career=${carTN}`:""}`);
    }
  }
  console.log(`\n=== C) competency/career 동일 skip 대상 라인 존재 = ${compCareerFlagged}건 (0이면 무영향=정책 동일) ===`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
