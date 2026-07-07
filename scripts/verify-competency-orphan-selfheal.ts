/**
 * [실무 역량] 고아(opened인데 라인 소실) self-heal 복구·검증 — phalanx 봄 W10(6cc59d70).
 *   npx tsx --env-file=.env.local scripts/verify-competency-orphan-selfheal.ts
 *
 * 1) before: 3명 resolution=opened, opened_line_id 있음, 실제 라인 MISSING
 * 2) 복구: openCompetencyHub(주차 게이트 통과) 또는 openApprovedApplications 직접 호출 → 라인/타깃 재생성
 * 3) after: 라인 존재, snapshot 재계산, HTTP competency lineTargetId+enh=success, 반영수(reflectedLines/Crews)=3
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  openCompetencyHub,
  resolveEffectiveWeek,
} from "../lib/adminCompetencyLineOpening";
import {
  openApprovedApplications,
  countOpenedCompetencyState,
} from "../lib/adminCompetencyApplications";
import { invalidateWeeklyCardsForUsers } from "../lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const IKEY = process.env.INTERNAL_API_KEY!;
const ORG = "phalanx";
const WEEK = "6cc59d70-3aa6-4823-8854-5b82691d1a84";
const J = (o: unknown) => JSON.stringify(o);

async function appsState(label: string) {
  const { data: apps } = await sb.from("cluster4_competency_applications")
    .select("target_user_id,resolution,opened_line_id")
    .eq("organization_slug", ORG).eq("week_id", WEEK).order("created_at");
  const out: any[] = [];
  for (const a of (apps ?? []) as any[]) {
    const line = a.opened_line_id ? (await sb.from("cluster4_lines").select("id").eq("id", a.opened_line_id).maybeSingle()).data : null;
    const tgts = a.opened_line_id ? ((await sb.from("cluster4_line_targets").select("id").eq("line_id", a.opened_line_id)).data ?? []).length : 0;
    out.push({ user: a.target_user_id.slice(0, 8), res: a.resolution, line: line ? "있음" : "MISSING", tgts });
  }
  console.log(`  [${label}] ${J(out)}`);
  return (apps ?? []).map((a: any) => a.target_user_id);
}

async function httpComp(uid: string) {
  const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": IKEY } });
  const j = await res.json();
  const cards = Array.isArray(j?.data) ? j.data : [];
  const out: any[] = [];
  for (const c of cards) if (c.weekId === WEEK) for (const l of (c.lines ?? [])) if (l.partType === "competency") out.push({ code: l.lineCode, tgt: l.lineTargetId ? "Y" : null, enh: l.enhancementStatus });
  return out;
}

async function main() {
  console.log("=== BEFORE ===");
  const users = await appsState("before");

  // 반영 상태(고아 제외) — 복구 전엔 0이어야
  const stateBefore = await countOpenedCompetencyState(ORG, WEEK);
  console.log(`  countOpenedCompetencyState(before) = ${J(stateBefore)} (고아 제외 → 0 기대)`);

  // ── 복구: 주차 게이트 통과되면 openCompetencyHub, 아니면 openApprovedApplications 직접 ──
  console.log("\n=== 복구(self-heal) ===");
  let reflected: { reflectedLines?: number; reflectedCrews?: number } = {};
  try {
    const eff = await resolveEffectiveWeek("operating", WEEK, ORG);
    console.log(`  resolveEffectiveWeek OK targetWeekId=${eff.targetWeekId?.slice(0, 8)} (주차 게이트 통과)`);
    const r = await openCompetencyHub({ organization: ORG as any, outputLink1: null, description: null, adminId: null, mode: "operating", weekId: WEEK });
    reflected = { reflectedLines: (r as any).reflectedLines, reflectedCrews: (r as any).reflectedCrews };
    console.log(`  openCompetencyHub → reflectedLines=${reflected.reflectedLines} reflectedCrews=${reflected.reflectedCrews} openedCrews=${r.openedCrews}`);
  } catch (e: any) {
    console.log(`  openCompetencyHub 주차게이트 차단(${e?.message}) → openApprovedApplications 직접 복구`);
    const r = await openApprovedApplications({ org: ORG as any, weekId: WEEK, outputLink1: null, description: null, adminId: null, mode: "operating" });
    console.log(`  openApprovedApplications → openedCrews=${r.openedCrews} openedLineIds=${r.openedLineIds.length}`);
    await invalidateWeeklyCardsForUsers(r.affectedUserIds);
    const st = await countOpenedCompetencyState(ORG, WEEK);
    reflected = { reflectedLines: st.lines, reflectedCrews: st.crews };
    console.log(`  countOpenedCompetencyState(after) = ${J(st)}`);
  }

  console.log("\n=== AFTER ===");
  await appsState("after");
  let allShown = true, allSuccess = true;
  for (const uid of users) {
    const comp = await httpComp(uid);
    const assigned = comp.filter((c) => c.tgt === "Y");
    if (assigned.length === 0) allShown = false;
    if (!assigned.every((c) => c.enh === "success")) allSuccess = false;
    console.log(`  user=${uid.slice(0, 8)} HTTP competency=${J(comp)}`);
  }
  console.log("\n=== 판정 ===");
  console.log(`  반영수(배너)= ${reflected.reflectedLines}개 (크루 ${reflected.reflectedCrews}명)  [3 기대]`);
  console.log(`  고객앱 3명 모두 라인 노출 = ${allShown}`);
  console.log(`  enhancementStatus 모두 success = ${allSuccess}`);
  console.log(`  => ${reflected.reflectedCrews === 3 && allShown && allSuccess ? "PASS ✅" : "FAIL ❌"}`);
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
