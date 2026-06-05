/**
 * READ-ONLY 진단3: w12 uws status 분포 + 봄 비휴식 주차 official_rest uws.
 *   npx tsx --env-file=.env.local scripts/diag-rest-week-data3.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: cols } = await sb.from("user_week_statuses").select("*").limit(1);
  console.log("uws columns:", cols && cols[0] ? Object.keys(cols[0]).join(", ") : "no rows");

  const { data: springWeeks, error: e0 } = await sb
    .from("weeks").select("id,week_number")
    .eq("season_key", "2026-spring").eq("is_official_rest", false);
  if (e0) throw e0;
  const ids = (springWeeks ?? []).map((w: any) => w.id);
  const wkNum = new Map((springWeeks ?? []).map((w: any) => [w.id, w.week_number]));

  const { data: badUws, error: e1 } = await sb
    .from("user_week_statuses")
    .select("user_id,week_id,status")
    .in("week_id", ids)
    .eq("status", "official_rest");
  if (e1) throw e1;
  const byWeek = new Map<string, number>();
  for (const r of badUws ?? []) byWeek.set(r.week_id, (byWeek.get(r.week_id) ?? 0) + 1);
  console.log("봄 비휴식 주차 official_rest uws:", [...byWeek].map(([id, n]) => `w${wkNum.get(id)}:${n}건`).join(", ") || "없음");
  if (badUws?.length) console.log("샘플:", JSON.stringify(badUws.slice(0, 20), null, 1));

  // w12 status 분포
  const w12 = "00000000-0000-0000-0000-202605210002";
  const { data: uws12 } = await sb.from("user_week_statuses").select("status").eq("week_id", w12);
  const dist = new Map<string, number>();
  for (const r of uws12 ?? []) dist.set(r.status, (dist.get(r.status) ?? 0) + 1);
  console.log("w12 uws status 분포:", JSON.stringify(Object.fromEntries(dist)), "총", uws12?.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
