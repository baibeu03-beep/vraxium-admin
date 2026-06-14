import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const u = process.argv[2] || "00b75923-2109-4214-806a-37667d64ac5e";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.keys(x).sort().reduce((o: any, k) => (o[k] = canon(x[k]), o), {}) : x);
(async () => {
  const stored = (await sb.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", u).maybeSingle()).data as any;
  const direct = await getCluster4WeeklyCardsForProfileUser(u);
  const cs = JSON.stringify(canon(stored?.cards ?? []));
  const cd = JSON.stringify(canon(direct));
  console.log(`\ncanonical(direct) == canonical(stored): ${cs === cd}`);
  console.log(`raw JSON.stringify equal: ${JSON.stringify(stored?.cards ?? []) === JSON.stringify(direct)}`);
  console.log(`(canonical=키정렬 후 비교 → 값 동일성, raw=키순서 포함)`);
})().catch(e => { console.error(e); process.exit(1); });
