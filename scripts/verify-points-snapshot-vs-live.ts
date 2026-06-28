/**
 * 포인트 SoT 조사용 검증 — STORED snapshot(=HTTP 응답) vs LIVE compute vs RAW ledger.
 *   snapshot-only 구조이므로 "코드(live)만" 확인하면 안 되고, 실제로 저장돼 HTTP 로 나가는
 *   snapshot 값과 일치하는지 봐야 한다. 이 스크립트는 READ-ONLY (recompute/store 안 함 → 운영 무변경).
 *
 *   1) 샘플 실유저 3명 선택(포인트 행 보유, 테스터 제외)
 *   2) readWeeklyCardsSnapshot  → 저장 카드(=API 가 내려주는 값)
 *   3) getCluster4WeeklyCardsForProfileUser → 실시간 재계산 카드
 *   4) 주차별 points.{star,shield,lightning} 를 snapshot vs live vs ledger 3자 비교
 *   5) 누적(이력서) Σ별/Σnet/Σ(−pen) 도 ledger 합으로 검증
 *   6) snapshot 신선도(computed_at / dto_version / is_stale) 리포트
 *
 *   npx tsx --env-file=.env.local scripts/verify-points-snapshot-vs-live.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

type Raw = { star: number; adv: number; pen: number };

async function ledgerByUser(userId: string): Promise<{ total: Raw; byWeek: Map<string, Raw> }> {
  const { data, error } = await supabaseAdmin
    .from("user_weekly_points")
    .select("week_start_date, points, advantages, penalty")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const total: Raw = { star: 0, adv: 0, pen: 0 };
  const byWeek = new Map<string, Raw>();
  for (const r of (data ?? []) as any[]) {
    total.star += r.points ?? 0;
    total.adv += r.advantages ?? 0;
    total.pen += r.penalty ?? 0;
    if (r.week_start_date) {
      const w = byWeek.get(r.week_start_date) ?? { star: 0, adv: 0, pen: 0 };
      w.star += r.points ?? 0;
      w.adv += r.advantages ?? 0;
      w.pen += r.penalty ?? 0;
      byWeek.set(r.week_start_date, w);
    }
  }
  return { total, byWeek };
}

async function pickSampleUsers(): Promise<string[]> {
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  // 포인트 행이 있는 사용자 중 실유저 — penalty>0 우선(net/raw 차이 드러나는 케이스)
  const seen = new Map<string, Raw>();
  for (let from = 0; from < 4000; from += 1000) {
    const { data } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id, points, advantages, penalty")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    for (const r of (data ?? []) as any[]) {
      if (testers.has(r.user_id)) continue;
      const v = seen.get(r.user_id) ?? { star: 0, adv: 0, pen: 0 };
      v.star += r.points ?? 0; v.adv += r.advantages ?? 0; v.pen += r.penalty ?? 0;
      seen.set(r.user_id, v);
    }
    if ((data ?? []).length < 1000) break;
  }
  const withPen = [...seen.entries()].filter(([, v]) => v.pen > 0).map(([id]) => id);
  const withAdv = [...seen.entries()].filter(([, v]) => v.pen === 0 && v.adv > 0).map(([id]) => id);
  return [...withPen.slice(0, 2), ...withAdv.slice(0, 1)];
}

async function main() {
  const userIds = await pickSampleUsers();
  if (userIds.length === 0) {
    console.log("샘플 사용자 없음 (user_weekly_points 비어있음?)");
    return;
  }
  let fail = 0;

  for (const userId of userIds) {
    const { data: prof } = await supabaseAdmin
      .from("user_profiles").select("display_name, organization_slug").eq("user_id", userId).maybeSingle();
    const ledger = await ledgerByUser(userId);
    const t = ledger.total;
    console.log(`\n■ ${prof?.display_name ?? "?"} (${userId.slice(0, 8)}, org=${prof?.organization_slug ?? "-"})`);
    console.log(`   원장 누적: star=${t.star} rawAdv=${t.adv} pen=${t.pen} net=${t.adv - t.pen}`);

    // snapshot 메타
    const { data: snapMeta } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version, is_stale, computed_at, card_count")
      .eq("user_id", userId).maybeSingle();
    const verMatch = snapMeta?.dto_version === WEEKLY_CARDS_DTO_VERSION;
    console.log(
      `   snapshot: dto_version=${snapMeta?.dto_version ?? "—"}(현재 ${WEEKLY_CARDS_DTO_VERSION}${verMatch ? " ✓" : " ✗STALE"})` +
      ` is_stale=${snapMeta?.is_stale ?? "—"} cards=${snapMeta?.card_count ?? "—"} computed_at=${snapMeta?.computed_at ?? "—"}`,
    );

    const snap = await readWeeklyCardsSnapshot(userId);
    const live = await getCluster4WeeklyCardsForProfileUser(userId);
    const snapCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const snapByStart = new Map(snapCards.map((c: any) => [c.startDate, c]));
    const liveByStart = new Map(live.map((c: any) => [c.startDate, c]));

    // 주차별 3자 비교(snapshot vs live vs ledger)
    let checked = 0, snapVsLive = 0, liveVsLedger = 0;
    const samples: string[] = [];
    for (const [start, lc] of liveByStart) {
      const w = ledger.byWeek.get(start);
      const sc: any = snapByStart.get(start);
      const expShield = w ? w.adv - w.pen : null;
      const expLight = w ? -w.pen : null;
      // live vs ledger
      if (w) {
        checked++;
        const liveOk = lc.points.star === w.star && lc.points.shield === expShield && lc.points.lightning === expLight;
        if (!liveOk) {
          liveVsLedger++;
          if (samples.length < 4) samples.push(
            `   ✗ live≠ledger ${start}: live(${lc.points.star}/${lc.points.shield}/${lc.points.lightning}) vs ledger(${w.star}/${expShield}/${expLight})`);
        }
      }
      // snapshot vs live
      if (sc) {
        const sOk = sc.points?.star === lc.points.star && sc.points?.shield === lc.points.shield && sc.points?.lightning === lc.points.lightning;
        if (!sOk) {
          snapVsLive++;
          if (samples.length < 4) samples.push(
            `   ✗ snapshot≠live ${start}: snap(${sc.points?.star}/${sc.points?.shield}/${sc.points?.lightning}) vs live(${lc.points.star}/${lc.points.shield}/${lc.points.lightning})`);
        }
      }
    }
    console.log(`   주차 비교: ${checked}주(원장보유) · live≠ledger ${liveVsLedger} · snapshot≠live ${snapVsLive}`);
    samples.forEach((s) => console.log(s));
    if (liveVsLedger > 0) fail++;
    if (snapVsLive > 0) { fail++; console.log("   ⚠ snapshot 이 stale — 재계산 필요(HTTP 응답이 구값)"); }
  }

  console.log(`\n${fail === 0 ? "✓ 전체 통과 (snapshot==live==ledger)" : `✗ 불일치 ${fail}건`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
