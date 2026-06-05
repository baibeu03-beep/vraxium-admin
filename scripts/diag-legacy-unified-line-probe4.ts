/**
 * READ-ONLY 진단 4: 스냅샷 DTO 실물 — 테스터 1명 + 실유저 1명, 봄 주차 카드 구조 확인.
 *   npx tsx --env-file=.env.local scripts/diag-legacy-unified-line-probe4.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = new Set((markers ?? []).map((m: any) => m.user_id));

  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at,card_count")
    .order("computed_at", { ascending: false })
    .limit(2000);
  const all = (snaps ?? []) as any[];
  console.log(`snapshots: ${all.length}`);
  const testerSnap = all.find((s) => testerIds.has(s.user_id) && s.card_count > 5);
  const realSnap = all.find((s) => !testerIds.has(s.user_id) && s.card_count > 3);
  console.log("tester snap:", JSON.stringify(testerSnap));
  console.log("real snap:", JSON.stringify(realSnap));

  for (const [label, snap] of [["TESTER", testerSnap], ["REAL", realSnap]] as const) {
    if (!snap) continue;
    const { data } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("cards")
      .eq("user_id", snap.user_id)
      .single();
    const cards = (data as any)?.cards as any[];
    console.log(`\n===== ${label} ${snap.user_id} cards=${cards?.length} =====`);
    for (const c of cards ?? []) {
      const lines = c.lines ?? [];
      const parts = new Map<string, number>();
      for (const l of lines) parts.set(l.partType, (parts.get(l.partType) ?? 0) + 1);
      console.log(
        `${c.startDate ?? c.weekStartDate} ${c.periodLabel ?? ""} status=${c.status ?? c.weekStatus} lines=[${[...parts.entries()].map(([p, n]) => `${p}:${n}`).join(",")}]`,
      );
    }
    // 봄 주차 카드 1장 풀 덤프 (3월 중 카드)
    const springCard = (cards ?? []).find((c) => String(c.startDate ?? "").startsWith("2026-03"));
    if (springCard) {
      console.log(`\n--- ${label} 2026-03 카드 풀 구조 ---`);
      console.log(JSON.stringify(springCard, null, 1).slice(0, 6000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
