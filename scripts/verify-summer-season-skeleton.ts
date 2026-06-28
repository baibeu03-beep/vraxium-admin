/**
 * 2026-summer 시즌 카드 골격 검증 (READ-ONLY).
 *   user_season_statuses 참여 row 가 있으나 user_week_statuses 가 없는 활동 회원에게
 *   2026-06-29(여름 W1) 시점 getWeeklyGrowth 가 여름 시즌 카드 골격(running "진행 중")을
 *   생성하는지 확인한다. 시스템 시계를 2026-06-29T00:00:01Z 로 시뮬레이션(=09:00 KST).
 *   DB 에 어떤 쓰기도 하지 않는다(getWeeklyGrowth 는 SELECT 전용).
 *
 *   npx tsx --env-file=.env.local scripts/verify-summer-season-skeleton.ts
 */
// ── 시계 시뮬레이션: new Date()(무인자)/Date.now() 만 고정, 그 외(파싱/포맷) 정상 ──
const FIXED = Date.UTC(2026, 5, 29, 0, 0, 1); // 2026-06-29T00:00:01Z = 2026-06-29 09:00 KST
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: any[]) { if (args.length === 0) { super(FIXED); } else { super(...(args as [])); } }
  static now() { return FIXED; }
}
// @ts-expect-error override global clock for simulation
globalThis.Date = FakeDate;

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

async function pickCandidates(limit: number): Promise<Array<{userId:string; name:string|null; growth:string|null; org:string|null}>> {
  const { data: uss } = await supabaseAdmin.from("user_season_statuses")
    .select("user_id,status").eq("season_key","2026-summer").eq("status","active");
  const ids = [...new Set((uss ?? []).map(r=>r.user_id))];
  // zero-uws filter
  const hasUws = new Set<string>();
  for (let i=0;i<ids.length;i+=200){
    const { data } = await supabaseAdmin.from("user_week_statuses").select("user_id").in("user_id", ids.slice(i,i+200));
    for (const r of data ?? []) hasUws.add(r.user_id);
  }
  const zero = ids.filter(id=>!hasUws.has(id));
  // batch fetch profiles (user_id UUID 가 getWeeklyGrowth 가 받는 키)
  const profs = new Map<string, any>();
  for (let i=0;i<zero.length;i+=200){
    const { data } = await supabaseAdmin.from("user_profiles")
      .select("user_id,display_name,growth_status,organization_slug").in("user_id", zero.slice(i,i+200));
    for (const p of data ?? []) profs.set(p.user_id, p);
  }
  const out: Array<{userId:string;name:string|null;growth:string|null;org:string|null}> = [];
  for (const id of zero) {
    const p = profs.get(id);
    if (!p) continue;
    if (p.growth_status && p.growth_status !== "active") continue; // 성장 중단/완료 제외(라우트 truncation 영향 회피)
    out.push({ userId:id, name:p.display_name, growth:p.growth_status, org:p.organization_slug });
    if (out.length >= limit) break;
  }
  return out;
}

async function main(){
  console.log("[clock] simulated now =", new Date().toISOString());
  const cands = await pickCandidates(3);
  if (cands.length === 0) { console.log("NO suitable candidate"); process.exit(2); }
  let allPass = true;
  for (const c of cands) {
    const g = await getWeeklyGrowth(c.userId);
    const cards = g?.weeklyCards ?? [];
    const summer = cards.filter(w => w.seasonKey === "2026-summer");
    const w1 = summer.find(w => w.weekNumber === 1);
    const seasonSummaryTitle = g?.seasonSummary ? g.seasonSummary.displayTitle : null;
    console.log(`\n--- ${c.name ?? c.userId} (uid=${c.userId}, org=${c.org}, growth=${c.growth}) ---`);
    console.log("  total cards:", cards.length, "| summer cards:", summer.length);
    console.log("  seasonSummary.displayTitle:", seasonSummaryTitle);
    if (w1) {
      console.log("  summer W1 =>", JSON.stringify({
        weekNumber: w1.weekNumber, resultStatus: w1.resultStatus, isTransition: w1.isTransition,
        pointsRaw: w1.pointsRaw, advantagesRaw: w1.advantagesRaw, penaltyRaw: w1.penaltyRaw,
        seasonKey: w1.seasonKey,
      }));
    } else {
      console.log("  summer W1 => MISSING");
    }
    const pass = !!w1 && w1.resultStatus === "running" && (w1.pointsRaw ?? 0) === 0;
    console.log("  RESULT:", pass ? "PASS (여름 W1 진행중·포인트0)" : "FAIL");
    if (!pass) allPass = false;
  }
  console.log("\n=== OVERALL:", allPass ? "PASS" : "FAIL", "===");
  process.exit(allPass ? 0 : 1);
}
main().catch(e=>{console.error(e);process.exit(1);});
