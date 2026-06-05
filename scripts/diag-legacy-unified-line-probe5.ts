/**
 * READ-ONLY 진단 5: user_week_statuses 분포 (week_start_date 기준, tester/real × status).
 *   npx tsx --env-file=.env.local scripts/diag-legacy-unified-line-probe5.ts
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

  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id,week_start_date,status,season_key")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`uws 총수: ${rows.length}`);
  const agg = new Map<string, Map<string, { t: number; r: number }>>();
  for (const u of rows) {
    const ws = u.week_start_date;
    if (!agg.has(ws)) agg.set(ws, new Map());
    const m = agg.get(ws)!;
    if (!m.has(u.status)) m.set(u.status, { t: 0, r: 0 });
    const a = m.get(u.status)!;
    if (testerIds.has(u.user_id)) a.t += 1; else a.r += 1;
  }
  for (const [ws, m] of [...agg.entries()].sort()) {
    console.log(
      `${ws} ${[...m.entries()].map(([s, a]) => `${s}=${a.t}t/${a.r}r`).join(" ")}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
