/** READ-ONLY 진단4: uws(week_start_date 기반) official_rest stale 점검. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const NON_REST_STARTS = ["2026-03-02","2026-03-09","2026-03-16","2026-03-23","2026-03-30","2026-04-27","2026-05-04","2026-05-11","2026-05-18","2026-05-25"];

async function main() {
  const { data, error } = await sb
    .from("user_week_statuses")
    .select("user_id,week_start_date,week_number,status,is_official_rest_override,season_key")
    .in("week_start_date", NON_REST_STARTS)
    .or("status.eq.official_rest,is_official_rest_override.eq.true");
  if (error) throw error;
  const byWeek = new Map<string, number>();
  for (const r of data ?? []) byWeek.set(r.week_start_date, (byWeek.get(r.week_start_date) ?? 0) + 1);
  console.log("봄 비휴식 주차 official_rest/override uws:", [...byWeek].sort().map(([d, n]) => `${d}:${n}건`).join(", ") || "없음");
  console.log("샘플:", JSON.stringify((data ?? []).slice(0, 20), null, 1));

  // w12 전체 분포
  const { data: w12 } = await sb.from("user_week_statuses")
    .select("status,is_official_rest_override").eq("week_start_date", "2026-05-18");
  const dist = new Map<string, number>();
  let ov = 0;
  for (const r of w12 ?? []) { dist.set(r.status, (dist.get(r.status) ?? 0) + 1); if (r.is_official_rest_override) ov++; }
  console.log("w12 uws 분포:", JSON.stringify(Object.fromEntries(dist)), "총", w12?.length, "override=true:", ov);
}
main().catch((e) => { console.error(e); process.exit(1); });
