/**
 * 포인트 표시 정책(2026-06-04 통일) direct 함수 검증.
 *   정책: 별=check · 방패(표시)=net(adv−pen) · 번개(표시)=−pen. raw advantage 는 내부 전용.
 *
 *   표면별 direct 결과 dump (raw advantage / penalty / net 동시 출력):
 *     A. 이력서 카드  getResumeCardForCrew → computed.totalStars/Shields/Lightnings
 *     B. 허브 진입    getWeeklyGrowth → seasonPointSummary (현재 시즌)
 *     C. 주차 카드    getCluster4WeeklyCardsForProfileUser → points.{star,shield,lightning} (v15 snapshot)
 *     D. 성장 코어    getCluster3StatsCards → points.totalStars/Shields/Lightning
 *
 *   기대치는 user_weekly_points 원장에서 독립 재계산해 비교한다.
 *   npx tsx --env-file=.env.local scripts/verify-point-display-policy.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getResumeCardForCrew } from "@/lib/adminResumeCardData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getCluster3StatsCards } from "@/lib/cluster3StatsCardsData";

type Raw = { star: number; adv: number; pen: number };

async function fetchRawAll(): Promise<Map<string, { total: Raw; byWeek: Map<string, Raw> }>> {
  const out = new Map<string, { total: Raw; byWeek: Map<string, Raw> }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id, week_start_date, points, advantages, penalty")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) {
      if (!out.has(r.user_id)) out.set(r.user_id, { total: { star: 0, adv: 0, pen: 0 }, byWeek: new Map() });
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
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name")
    .order("user_id", { ascending: true })
    .range(0, 1999);
  const nameBy = new Map((profs ?? []).map((p: any) => [p.user_id, p.display_name]));

  // 대상: penalty>0 실유저 2명(옥지윤 포함) + 테스터 1명 + penalty=0 실유저 1명(대조군)
  const realPen = [...rawAll.entries()].filter(([id, v]) => !testers.has(id) && v.total.pen > 0);
  const realZero = [...rawAll.entries()].filter(([id, v]) => !testers.has(id) && v.total.pen === 0 && v.total.adv > 0);
  const testerPen = [...rawAll.entries()].filter(([id, v]) => testers.has(id) && v.total.pen > 0);
  const targets = [
    ...realPen.filter(([id]) => nameBy.get(id) === "옥지윤"),
    ...realPen.filter(([id]) => nameBy.get(id) !== "옥지윤").slice(0, 1),
    ...realZero.slice(0, 1),
    ...testerPen.slice(0, 1),
  ];

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
      `\n■ ${testers.has(userId) ? "[테스터]" : "[실유저]"} ${nameBy.get(userId) ?? "?"} (${userId.slice(0, 8)})` +
        ` — 원장: rawAdv=${t.adv} penalty=${t.pen} net=${expNet} star=${t.star}`,
    );

    // A. 이력서 카드 (admin direct)
    const bundle = await getResumeCardForCrew(userId);
    console.log(" A. 이력서 카드 computed:");
    expectEq("totalStars(별)", bundle?.computed.totalStars, t.star);
    expectEq("totalShields(방패=net)", bundle?.computed.totalShields, expNet);
    expectEq("totalLightnings(번개=−pen)", bundle?.computed.totalLightnings, -t.pen);

    // B. 허브 진입 seasonPointSummary (현재 시즌 비전환 주차 한정 — 기대치는 카드 기반 재계산)
    const growth = await getWeeklyGrowth(userId);
    if (growth) {
      const s = growth.seasonPointSummary;
      console.log(` B. seasonPointSummary(현재 시즌): star=${s.star} shield=${s.shield} lightning=${s.lightning}`);
      if (s.shield < 0 && s.lightning === 0) {
        console.log("   ✗ shield<0 인데 lightning=0 — 의심");
        fail++;
      }
      // 정책 불변식: shield(net) = (시즌 rawAdv) − pen, lightning = −pen ⇒ lightning ≤ 0
      expectEq("lightning ≤ 0", s.lightning <= 0, true);
    }

    // C. 주차 카드 (v15 snapshot) — 주차별 points 가 원장 net/−pen 과 일치하는지 전수 비교
    const cards = await getCluster4WeeklyCardsForProfileUser(userId);
    let cardChecked = 0;
    let cardMismatch = 0;
    const samples: string[] = [];
    for (const c of cards) {
      const w = raw.byWeek.get(c.startDate);
      if (!w) continue; // 포인트 row 없는 주차 (points null 허용)
      cardChecked++;
      const expShield = w.adv - w.pen;
      const expLight = -w.pen;
      const ok = c.points.star === w.star && c.points.shield === expShield && c.points.lightning === expLight;
      if (!ok) cardMismatch++;
      if (samples.length < 3 && (w.pen > 0 || w.adv > 0)) {
        samples.push(
          `${c.startDate}: raw(adv=${w.adv},pen=${w.pen}) → 표시(star=${c.points.star},shield=${c.points.shield},lightning=${c.points.lightning})${ok ? "" : " ✗"}`,
        );
      }
    }
    console.log(` C. 주차 카드 (${cardChecked}주 검사, 불일치 ${cardMismatch}건)${cardMismatch ? " ✗" : " ✓"}`);
    samples.forEach((s) => console.log(`   · ${s}`));
    if (cardMismatch) fail++;

    // D. 성장 코어 stats-cards
    const sc = await getCluster3StatsCards(userId);
    if (sc) {
      console.log(" D. 성장 코어 points:");
      expectEq("totalStars(별)", sc.points.totalStars, t.star);
      expectEq("totalShields(방패=net)", sc.points.totalShields, expNet);
      expectEq("totalLightning(번개=−pen)", sc.points.totalLightning, -t.pen);
    }
  }

  console.log(`\n${fail === 0 ? "✓ 전체 통과" : `✗ 실패 ${fail}건`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
