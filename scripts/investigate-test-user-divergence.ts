// 읽기 전용 — 테스트 유저의 mode=test(summer-sim live) vs snapshot 경로 DTO 차이 재현.
// 사용법: npx tsx --env-file=.env.local scripts/investigate-test-user-divergence.ts
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "../lib/lineAvailability";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Card = { weekId?: string; startDate?: string; weekNumber?: number; growthNumerator?: number; growthDenominator?: number; userWeekStatus?: string; lines?: any[] };
function sig(cards: Card[]): string[] {
  return (cards ?? []).map((c) =>
    `${c.startDate ?? c.weekId}|W${c.weekNumber}|${c.userWeekStatus}|${c.growthNumerator}/${c.growthDenominator}|lines=${(c.lines ?? []).length}`,
  );
}

async function main() {
  // 테스트 유저 1명(스냅샷 보유) 선택.
  const { data: snaps } = await supabase.from("cluster4_weekly_card_snapshots").select("user_id").limit(500);
  const ids = Array.from(new Set((snaps ?? []).map((s: any) => s.user_id)));
  let target: string | null = null;
  for (const uid of ids) {
    const { data: m } = await supabase.from("test_user_markers").select("user_id").eq("user_id", uid).maybeSingle();
    if (m) { target = uid; break; }
  }
  if (!target) { console.log("테스트 유저(snapshot 보유) 미발견"); return; }
  const { data: prof } = await supabase.from("user_profiles").select("display_name,organization_slug").eq("user_id", target).maybeSingle();
  console.log(`테스트 유저: ${prof?.display_name} (${target}) org=${prof?.organization_slug}`);

  // 경로 A: mode=test → 라이브 summer-sim (route 가 하는 것과 동일).
  const live = (await getCluster4WeeklyCardsForProfileUser(target, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM })) as unknown as Card[];
  // 경로 B: snapshot-only (loadWeeklyCards 가 읽는 저장본).
  const snapRow: any = await readWeeklyCardsSnapshot(target);
  const snap = (snapRow?.cards ?? []) as Card[];
  // 경로 C: 라이브(override 없음) — snapshot 재계산 결과와 동일해야.
  const liveNoOverride = (await getCluster4WeeklyCardsForProfileUser(target)) as unknown as Card[];

  const sigLive = sig(live), sigSnap = sig(snap), sigPlain = sig(liveNoOverride);
  console.log(`\nA. mode=test summer-sim(live)   카드=${live.length}`);
  console.log(`B. snapshot(저장=snapshot-only)  카드=${snap.length} status=${snapRow?.status}`);
  console.log(`C. live(override 없음)           카드=${liveNoOverride.length}`);

  const aVsB = JSON.stringify(sigLive) === JSON.stringify(sigSnap);
  const cVsB = JSON.stringify(sigPlain) === JSON.stringify(sigSnap);
  console.log(`\nA(summer-sim) == B(snapshot) ? ${aVsB ? "동일" : "★다름★ ← 진입경로 divergence 원인"}`);
  console.log(`C(plain live) == B(snapshot) ? ${cVsB ? "동일(snapshot 최신)" : "다름(snapshot stale 가능)"}`);

  if (!aVsB) {
    console.log("\n[차이 샘플] A(summer-sim) vs B(snapshot) 첫 5개 주차:");
    const n = Math.max(sigLive.length, sigSnap.length);
    let shown = 0;
    for (let i = 0; i < n && shown < 5; i++) {
      if (sigLive[i] !== sigSnap[i]) {
        console.log(`  A: ${sigLive[i] ?? "∅"}`);
        console.log(`  B: ${sigSnap[i] ?? "∅"}`);
        console.log("  ---");
        shown++;
      }
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
