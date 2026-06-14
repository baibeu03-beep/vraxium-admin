// READ-ONLY: direct vs stored snapshot diff 원인 추적.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const u = process.argv[2] || "00b75923-2109-4214-806a-37667d64ac5e";

function diffCards(a: any[], b: any[], la: string, lb: string) {
  if (a.length !== b.length) { console.log(`  카드 수 차이: ${la}=${a.length} ${lb}=${b.length}`); return; }
  for (let i = 0; i < a.length; i++) {
    const sa = JSON.stringify(a[i]), sb_ = JSON.stringify(b[i]);
    if (sa !== sb_) {
      console.log(`  카드[${i}] week=${a[i].weekId} 차이:`);
      // 필드별 차이.
      const ka = new Set([...Object.keys(a[i]), ...Object.keys(b[i])]);
      for (const k of ka) {
        const va = JSON.stringify(a[i][k]), vb = JSON.stringify(b[i][k]);
        if (va !== vb) console.log(`     .${k}: ${la}=${va?.slice(0, 120)} | ${lb}=${vb?.slice(0, 120)}`);
      }
    }
  }
}

async function main() {
  const stored = (await sb.from("cluster4_weekly_card_snapshots").select("cards,dto_version,computed_at").eq("user_id", u).maybeSingle()).data as any;
  const d1 = await getCluster4WeeklyCardsForProfileUser(u);
  const d2 = await getCluster4WeeklyCardsForProfileUser(u);
  console.log(`user=${u} stored dto_v=${stored?.dto_version} computed_at=${stored?.computed_at}`);
  console.log(`direct1=${d1.length} direct2=${d2.length} stored=${(stored?.cards ?? []).length}`);
  console.log(`\ndirect1 == direct2 : ${JSON.stringify(d1) === JSON.stringify(d2)}`);
  console.log(`direct1 == stored  : ${JSON.stringify(d1) === JSON.stringify(stored?.cards ?? [])}`);
  if (JSON.stringify(d1) !== JSON.stringify(d2)) { console.log("\n[direct1 vs direct2 차이 — 비결정성]"); diffCards(d1, d2, "d1", "d2"); }
  if (JSON.stringify(d1) !== JSON.stringify(stored?.cards ?? [])) { console.log("\n[direct1 vs stored 차이]"); diffCards(d1, stored?.cards ?? [], "direct", "stored"); }
}
main().catch((e) => { console.error(e); process.exit(1); });
