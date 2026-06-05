/** READ-ONLY 진단: user_season_histories.rating / season_reputations.rating 분포. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: ush } = await sb.from("user_season_histories").select("rating").not("rating", "is", null);
  const dist = new Map<number, number>();
  for (const r of ush ?? []) dist.set(r.rating, (dist.get(r.rating) ?? 0) + 1);
  console.log("user_season_histories.rating 분포:", JSON.stringify([...dist].sort((a,b)=>a[0]-b[0])));
  const { data: sr } = await sb.from("season_reputations").select("rating").not("rating", "is", null);
  const dist2 = new Map<number, number>();
  for (const r of sr ?? []) dist2.set(r.rating, (dist2.get(r.rating) ?? 0) + 1);
  console.log("season_reputations.rating 분포:", JSON.stringify([...dist2].sort((a,b)=>a[0]-b[0])));
}
main().catch((e) => { console.error(e); process.exit(1); });
