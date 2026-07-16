/* eslint-disable @typescript-eslint/no-explicit-any */
// 정정 결과 검증(전 소비처 대조): phalanx w1 team 13e60f37 도출 5명.
//   selected_line_id / cluster4_lines.master / cluster4_line_targets.line_id /
//   크루 weekly-cards(getCluster4WeeklyCardsForProfileUser) / 회원 상세(resolveCrewWeekCard) /
//   snapshot(readWeeklyCardsSnapshot) lineId·lineName 을 사용자별로 대조.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-line-correction-result.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { listExperienceOverallLineOptions } from "@/lib/adminExperienceLineData";

const ORG = "phalanx";
const WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";
const TEAM = "13e60f37-152c-4e53-8d65-f633cc48d81c";

let pass = 0, fail = 0;
const ck = (ok: boolean, label: string) => { console.log(`  ${ok ? "✓" : "✗"} ${label}`); ok ? pass++ : fail++; };

async function main() {
  const derivSet = new Set((await listExperienceOverallLineOptions(ORG)).derivation.map((o) => o.id));
  const { data: masters } = await supabaseAdmin.from("cluster4_experience_line_masters").select("id,line_name").in("id", Array.from(derivSet));
  const nameByMaster = new Map<string, string>(); for (const m of (masters ?? []) as any[]) nameByMaster.set(m.id, m.line_name);

  // 셀 선택(도출).
  const { data: pH } = await supabaseAdmin.from("cluster4_experience_part_submissions").select("id").eq("organization_slug", ORG).eq("week_id", WEEK).eq("team_id", TEAM);
  const pIds = ((pH ?? []) as any[]).map((r) => r.id);
  const selDeriv = new Map<string, string | null>();
  if (pIds.length) {
    const { data: pc } = await supabaseAdmin.from("cluster4_experience_part_submission_cells").select("crew_user_id,selected_line_id,checked,score").in("submission_id", pIds).eq("line_type", "derivation");
    for (const c of (pc ?? []) as any[]) selDeriv.set(c.crew_user_id, c.checked && c.score > 0 ? c.selected_line_id : null);
  }
  // 이 팀 도출 라인 + w1 타깃.
  const { data: teamLines } = await supabaseAdmin.from("cluster4_lines").select("id,experience_line_master_id").eq("part_type", "experience").eq("team_id", TEAM);
  const masterByLine = new Map<string, string>(); for (const l of (teamLines ?? []) as any[]) masterByLine.set(l.id, l.experience_line_master_id);
  const { data: tgts } = await supabaseAdmin.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", Array.from(masterByLine.keys())).eq("week_id", WEEK);
  // 도출 타깃(배정 라인 master ∈ 도출)만, 사용자별.
  const derivTgtByUser = new Map<string, { tgtId: string; lineId: string; master: string }>();
  for (const t of (tgts ?? []) as any[]) {
    const m = masterByLine.get(t.line_id);
    if (m && derivSet.has(m)) derivTgtByUser.set(t.target_user_id, { tgtId: t.id, lineId: t.line_id, master: m });
  }

  // 검증 대상 = 선택이 있는 도출 사용자.
  const users = Array.from(derivTgtByUser.keys()).filter((u) => selDeriv.get(u));
  console.log(`대조 대상(도출 배정+선택 보유): ${users.length}명\n`);
  console.log("user      | sel_master | line.master | target.line_id | wc lineId  | wc lineName             | detail lineId | detail Name | snap lineId | snap Name");

  for (const u of users) {
    const sel = selDeriv.get(u)!;
    const tgt = derivTgtByUser.get(u)!;
    // 크루 weekly-cards.
    const wc = await getCluster4WeeklyCardsForProfileUser(u);
    const wcard = wc.find((c: any) => c.weekId === WEEK);
    const wl = (wcard?.lines ?? []).find((l: any) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId);
    // 회원 상세.
    const rc = await resolveCrewWeekCard(u, WEEK);
    const rl = rc.ok ? (rc.card.lines as any[]).find((l) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId) : null;
    // snapshot.
    const sn = await readWeeklyCardsSnapshot(u);
    const scard = (sn.status === "hit" || sn.status === "stale") ? sn.cards.find((c: any) => c.weekId === WEEK) : null;
    const sl = (scard?.lines ?? []).find((l: any) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId);

    const s = (x: any) => (x ? String(x).slice(0, 8) : "∅");
    console.log(`${s(u)}… | ${s(sel)} | ${s(tgt.master)} | ${s(tgt.lineId)} | ${s(wl?.lineId)} | ${(wl?.lineName ?? "∅").padEnd(22)} | ${s(rl?.lineId)} | ${(rl?.lineName ?? "∅").padEnd(10)} | ${s(sl?.lineId)} | ${sl?.lineName ?? "∅"}`);

    const want = nameByMaster.get(sel);
    ck(tgt.master === sel, `${s(u)} target.line master == selected`);
    ck(wl?.experienceLineMasterId === sel && wl?.lineName === want, `${s(u)} weekly-cards == 선택 라인명(${want})`);
    ck(!!rl && rl.lineId === wl?.lineId && rl.lineName === wl?.lineName, `${s(u)} 회원상세 == weekly-cards`);
    ck(!!sl && sl.lineId === wl?.lineId && sl.lineName === wl?.lineName, `${s(u)} snapshot == weekly-cards`);
    ck(wl?.lineId === tgt.lineId, `${s(u)} card lineId == target.line_id`);
  }

  // 교차오염: 선택이 다른 사용자끼리 lineId 상이.
  const byMaster = new Map<string, Set<string>>();
  for (const u of users) { const m = selDeriv.get(u)!; const s = byMaster.get(m) ?? new Set(); s.add(derivTgtByUser.get(u)!.lineId); byMaster.set(m, s); }
  const distinctMasters = byMaster.size;
  const allLineIds = new Set(users.map((u) => derivTgtByUser.get(u)!.lineId));
  ck(allLineIds.size === distinctMasters, `선택 master ${distinctMasters}종 == 배정 라인 ${allLineIds.size}개(1:1, 교차오염 0)`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
