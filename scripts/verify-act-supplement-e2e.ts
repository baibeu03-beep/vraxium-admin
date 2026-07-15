/**
 * 액트 보완 실데이터 E2E 검증 — 서비스 롤 직접(레포 verify 관례). 테스트 유저만·생성물 정리(무손실).
 *   tsx --env-file=.env.local scripts/verify-act-supplement-e2e.ts
 *
 * 검증:
 *   [AB] A=2,B=1,C=0 보완 → 액트/원장 생성, uwp A+2·raw B+1·C불변·finalB+1, 관리자·고객 목록 +1행.
 *   [C ] A=0,B=0,C=2 보완 → C+2·raw B 불변·finalB−2.
 *   [CUST] 생성 액트가 고객 actLogs(default)에 노출(취소 전).
 *   [CLEAN] 생성물(award/recipients/act) 삭제 + 재집계 → 원래 합계 복귀.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { createActSupplement } from "@/lib/adminProcessIrregularData";
import { recomputeWeeklyPointsForUsers } from "@/lib/processPointAccrual";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";

const out: Array<{ id: string; pass: boolean; d: string }> = [];
const check = (id: string, pass: boolean, d: string) => { out.push({ id, pass, d }); console.log(`  [${id}] ${pass ? "PASS" : "FAIL"} — ${d}`); };

async function uwp(u: string, y: number, w: number) {
  const { data } = await supabaseAdmin.from("user_weekly_points").select("points,advantages,penalty")
    .eq("user_id", u).eq("year", y).eq("week_number", w).maybeSingle();
  const r = (data ?? { points: 0, advantages: 0, penalty: 0 }) as { points: number; advantages: number; penalty: number };
  return { a: r.points, b: r.advantages, c: r.penalty, finalB: (r.advantages ?? 0) - (r.penalty ?? 0) };
}
async function custCount(u: string, start: string) {
  const m = await loadActLogsByStartDate(u);
  return (m.get(start) ?? []).length;
}
async function admHas(u: string, start: string, awardId: string | null) {
  if (!awardId) return false;
  const m = await loadActLogsByStartDate(u, { includeCancelled: true });
  return (m.get(start) ?? []).some((l) => l.awardId === awardId);
}

async function discover() {
  const tm = await supabaseAdmin.from("test_user_markers").select("user_id").limit(500);
  const ids = ((tm.data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (!ids.length) return null;
  // 적립 era 이후 주차의 test 유저 award 하나 → 그 (user, week) 사용.
  const { data } = await supabaseAdmin.from("process_point_awards")
    .select("user_id,year,week_number").in("user_id", ids).in("source", ["regular", "irregular"]).limit(200);
  const rows = (data ?? []) as { user_id: string; year: number; week_number: number }[];
  for (const r of rows) {
    const { data: wk } = await supabaseAdmin.from("weeks").select("id,start_date")
      .eq("iso_year", r.year).eq("iso_week", r.week_number).limit(1).maybeSingle();
    const w = wk as { id: string; start_date: string } | null;
    if (w && w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) {
      const { data: prof } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id", r.user_id).maybeSingle();
      const org = (prof as { organization_slug: string | null } | null)?.organization_slug ?? null;
      if (org) return { userId: r.user_id, year: r.year, wk: r.week_number, weekId: w.id, startDate: w.start_date, org };
    }
  }
  return null;
}

async function cleanup(actIds: string[], userId: string, weekId: string) {
  for (const id of actIds) {
    await supabaseAdmin.from("process_point_awards").delete().eq("source", "irregular").eq("ref_id", id);
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", id);
    await supabaseAdmin.from("process_irregular_acts").delete().eq("id", id);
  }
  await recomputeWeeklyPointsForUsers([userId], weekId);
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
}

async function main() {
  const s = await discover();
  if (!s) { console.error("적합한 테스트 대상 없음"); process.exit(2); }
  const { userId, year, wk, weekId, startDate, org } = s;
  // applicant_admin_id → admin_users.id (FK). 실 API 는 requireAdmin 의 admin.userId(=admin_users.id).
  const { data: adm } = await supabaseAdmin.from("admin_users").select("id").limit(1).maybeSingle();
  const adminId = (adm as { id: string } | null)?.id;
  if (!adminId) { console.error("admin_users 없음"); process.exit(2); }
  console.log(`\ntest user=${userId} org=${org} week=(${year},W${wk}) start=${startDate} admin=${adminId}\n`);

  const before = await uwp(userId, year, wk);
  const custBefore = await custCount(userId, startDate);
  const created: string[] = [];
  try {
    // [AB]
    const ab = await createActSupplement({ organization: org, mode: "test", adminId, userId, weekId, actName: "E2E보완AB", reason: "verify", pointA: 2, pointB: 1, pointC: 0 });
    created.push(ab.actId);
    const afterAB = await uwp(userId, year, wk);
    check("AB", afterAB.a === before.a + 2 && afterAB.b === before.b + 1 && afterAB.c === before.c && afterAB.finalB === before.finalB + 1,
      `uwp A ${before.a}→${afterAB.a}, rawB ${before.b}→${afterAB.b}, C ${before.c}→${afterAB.c}, finalB ${before.finalB}→${afterAB.finalB}`);
    check("AB-cust", (await custCount(userId, startDate)) === custBefore + 1 && (await admHas(userId, startDate, ab.awardId)),
      `고객 목록 +1행 & 관리자 노출(awardId=${ab.awardId})`);

    // [C]
    const baseC = await uwp(userId, year, wk);
    const c = await createActSupplement({ organization: org, mode: "test", adminId, userId, weekId, actName: "E2E보완C", reason: "verify", pointA: 0, pointB: 0, pointC: 2 });
    created.push(c.actId);
    const afterC = await uwp(userId, year, wk);
    check("C", afterC.c === baseC.c + 2 && afterC.b === baseC.b && afterC.finalB === baseC.finalB - 2,
      `C ${baseC.c}→${afterC.c}, rawB ${baseC.b}→${afterC.b}, finalB ${baseC.finalB}→${afterC.finalB}`);
  } finally {
    await cleanup(created, userId, weekId);
  }

  const restored = await uwp(userId, year, wk);
  const custRestored = await custCount(userId, startDate);
  check("CLEAN", restored.a === before.a && restored.b === before.b && restored.c === before.c && custRestored === custBefore,
    `원복 uwp ${restored.a}/${restored.b}/${restored.c} (기대 ${before.a}/${before.b}/${before.c}), cust ${custRestored}/${custBefore}`);

  const all = out.every((r) => r.pass);
  console.log(`\n=== ${all ? "ALL PASS" : "FAILURE 있음"} ===`);
  process.exit(all ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
