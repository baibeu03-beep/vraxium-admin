/**
 * 어드민 포인트 4컬럼(Check / Advantage(Raw) / Penalty / Net Advantage) 검증.
 *   정책(2026-06-04): 고객 화면 방패 = net(advantage − penalty), raw 는 내부 전용.
 *
 *   raw ≠ net 실유저(penalty>0)를 대상으로:
 *     A. /admin/members 집계   listMembers → check/advantage/penalty/netAdvantage
 *     B. 주차 상태 화면        getUserWeeklyStatus → weekly_*_count (+net)
 *     C. 고객 주차 카드        getCluster4WeeklyCardsForProfileUser → points.shield 가
 *        어드민 net 과 주차 단위로 일치하는지 (고객 화면 값 = Net Advantage 확인)
 *
 *   기대치는 user_weekly_points 원장에서 독립 재계산해 비교한다.
 *   npx tsx --env-file=.env.local scripts/verify-admin-point-columns.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listMembers } from "@/lib/adminMembersData";
import { getUserWeeklyStatus } from "@/lib/adminUserWeeklyStatusData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

type Raw = { star: number; adv: number; pen: number };

async function fetchRawAll(): Promise<
  Map<string, { total: Raw; byWeek: Map<string, Raw> }>
> {
  const out = new Map<string, { total: Raw; byWeek: Map<string, Raw> }>();
  // PostgREST 1000행 cap — 전수 페이지네이션 필수.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id, week_start_date, points, advantages, penalty")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) {
      if (!out.has(r.user_id))
        out.set(r.user_id, { total: { star: 0, adv: 0, pen: 0 }, byWeek: new Map() });
      const u = out.get(r.user_id)!;
      u.total.star += r.points ?? 0;
      u.total.adv += r.advantages ?? 0;
      u.total.pen += r.penalty ?? 0;
      if (r.week_start_date) {
        const w = u.byWeek.get(r.week_start_date) ?? { star: 0, adv: 0, pen: 0 };
        w.star += r.points ?? 0;
        w.adv += r.advantages ?? 0;
        w.pen += r.penalty ?? 0;
        u.byWeek.set(r.week_start_date, w);
      }
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const rawAll = await fetchRawAll();
  const { data: markers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name")
    .order("user_id", { ascending: true })
    .range(0, 1999);
  const nameBy = new Map((profs ?? []).map((p: any) => [p.user_id, p.display_name]));

  // 대상: raw≠net 실유저 2명 (net>0 1명 + net<0 1명) — raw 와 net 이 다른 사례 강제.
  const diff = [...rawAll.entries()].filter(
    ([id, v]) => !testers.has(id) && v.total.pen > 0,
  );
  const targets = [
    ...diff.filter(([, v]) => v.total.adv - v.total.pen > 0).slice(0, 1),
    ...diff.filter(([, v]) => v.total.adv - v.total.pen < 0).slice(0, 1),
  ];
  if (targets.length === 0) throw new Error("raw≠net 실유저 사례 없음");

  let fail = 0;
  const expectEq = (label: string, actual: unknown, expected: unknown) => {
    const ok = actual === expected;
    if (!ok) fail++;
    console.log(`   ${ok ? "✓" : "✗"} ${label}: ${actual} (기대 ${expected})`);
  };

  for (const [userId, raw] of targets) {
    const t = raw.total;
    const expNet = t.adv - t.pen;
    console.log(
      `\n■ [실유저] ${nameBy.get(userId) ?? "?"} (${userId.slice(0, 8)})` +
        ` — 원장: check=${t.star} rawAdv=${t.adv} pen=${t.pen} net=${expNet}`,
    );

    // A. /admin/members 집계 — user_id 완전일치 검색으로 단건 조회.
    const { members } = await listMembers({ query: userId, limit: 1 });
    const m = members.find((x) => x.userId === userId);
    console.log(" A. /admin/members listMembers:");
    expectEq("checkPoints(Check)", m?.checkPoints, t.star);
    expectEq("advantagePoints(Advantage Raw)", m?.advantagePoints, t.adv);
    expectEq("penaltyPoints(Penalty)", m?.penaltyPoints, t.pen);
    expectEq("netAdvantagePoints(Net Advantage)", m?.netAdvantagePoints, expNet);

    // B. 주차 상태 화면 — 주차 합 = 원장 합, 그리고 모든 행에서 net = raw − pen.
    const ws = await getUserWeeklyStatus(userId);
    const sum = ws.rows.reduce(
      (acc, r) => ({
        star: acc.star + r.weekly_star_count,
        adv: acc.adv + r.weekly_shield_count,
        pen: acc.pen + r.weekly_lightning_count,
        net: acc.net + r.weekly_net_shield_count,
      }),
      { star: 0, adv: 0, pen: 0, net: 0 },
    );
    const rowInvariantOk = ws.rows.every(
      (r) =>
        r.weekly_net_shield_count ===
        r.weekly_shield_count - r.weekly_lightning_count,
    );
    console.log(" B. 주차 상태(getUserWeeklyStatus):");
    expectEq("Σ weekly_star_count", sum.star, t.star);
    expectEq("Σ weekly_shield_count(raw)", sum.adv, t.adv);
    expectEq("Σ weekly_lightning_count(pen)", sum.pen, t.pen);
    expectEq("Σ weekly_net_shield_count", sum.net, expNet);
    expectEq("모든 행 net = raw − pen", rowInvariantOk, true);

    // C. 고객 주차 카드(snapshot) — 주차별 고객 shield == 어드민 net (동일 주차 키).
    const cards = await getCluster4WeeklyCardsForProfileUser(userId);
    let checked = 0;
    let mismatch = 0;
    const samples: string[] = [];
    for (const c of cards) {
      const w = raw.byWeek.get(c.startDate);
      if (!w) continue;
      checked++;
      const adminNet = w.adv - w.pen;
      const ok =
        c.points.shield === adminNet && c.points.lightning === -w.pen;
      if (!ok) mismatch++;
      if (samples.length < 3 && (w.pen > 0 || w.adv > 0)) {
        samples.push(
          `${c.startDate}: 어드민 raw=${w.adv} pen=${w.pen} net=${adminNet}` +
            ` ↔ 고객 shield=${c.points.shield} lightning=${c.points.lightning}${ok ? "" : " ✗"}`,
        );
      }
    }
    console.log(
      ` C. 고객 카드 shield == 어드민 net (${checked}주 검사, 불일치 ${mismatch}건)${mismatch ? " ✗" : " ✓"}`,
    );
    samples.forEach((s) => console.log(`   · ${s}`));
    if (mismatch) fail++;
  }

  console.log(`\n${fail === 0 ? "✓ 전체 통과" : `✗ 실패 ${fail}건`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
