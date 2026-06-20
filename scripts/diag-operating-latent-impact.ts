/**
 * diag-operating-latent-impact.ts (READ-ONLY)
 * 운영유저 김세진의 (1) stored snapshot(현재 served) vs (2) live 재계산 결과에서
 * W1~W11 info 라인 수 비교. live 가 test 타깃으로 개설된 29 라인을 openedFail 로 집어오는지 확인.
 *   - served(stored): 변하지 않음(재계산 안 함) → 운영 화면 현재 영향 0
 *   - live(미래 재계산 시): 값 → 잠재 영향 측정
 * 실행: npx tsx --env-file=.env.local scripts/diag-operating-latent-impact.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PROBE = "209e27c2-2ee4-4e26-b38f-4d11cea564cb"; // 김세진(운영)

function countInfo(cards: any[], wn: Map<string, number>) {
  let n = 0; const per: Record<number, number> = {};
  for (const c of cards) {
    const w = wn.get(c.weekId); if (w == null) continue;
    const infos = (c.lines ?? []).filter((l: any) => l.partType === "information" && l.lineId);
    if (infos.length) { per[w] = infos.length; n += infos.length; }
  }
  return { n, per };
}

async function main() {
  const { data: weeks } = await sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").gte("week_number", 1).lte("week_number", 11);
  const wn = new Map((weeks ?? []).map((w: any) => [w.id, w.week_number]));

  const snap = await readWeeklyCardsSnapshot(PROBE);
  const stored = (snap.status === "hit" || snap.status === "stale") ? countInfo((snap as any).cards, wn) : { n: -1, per: {} };
  console.log(`[stored/served] 김세진 snapshot status=${snap.status} computed_at=${(snap as any).computedAt ?? "-"}`);
  console.log(`  W1~11 info 라인 수(현재 운영 화면): ${stored.n}  per=${JSON.stringify(stored.per)}`);

  const live = await getCluster4WeeklyCardsForProfileUser(PROBE);
  const liveC = countInfo(live, wn);
  console.log(`\n[live/미래 재계산 시] 김세진 W1~11 info 라인 수: ${liveC.n}  per=${JSON.stringify(liveC.per)}`);

  console.log(`\n=== 결론 ===`);
  console.log(`  현재 운영 화면(served): info ${stored.n}개 — 변경 없음(재계산 안 함)`);
  console.log(`  미래 재계산 시(live):   info ${liveC.n}개`);
  if (liveC.n > 0) console.log(`  ⚠ 잠재 영향: 운영유저가 재계산되면 test 개설 라인 ${liveC.n}개가 openedFail 로 노출될 수 있음(롤백으로 제거).`);
  else console.log(`  ✅ 잠재 영향 없음: live 에서도 운영유저 W1~11 info 0개.`);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
