/**
 * 주차별 uws 참여자 수 (check-threshold 저장 시 snapshot 재계산 규모 파악용). read-only.
 *   npx tsx --env-file=.env.local scripts/diag-week-uws-counts.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,start_date,season_key,week_number,result_published_at")
    .order("start_date");
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_week_statuses")
      .select("week_start_date")
      .order("id")
      .range(from, from + 999);
    for (const r of (data ?? []) as { week_start_date: string }[]) {
      counts.set(r.week_start_date, (counts.get(r.week_start_date) ?? 0) + 1);
    }
    if (!data || data.length < 1000) break;
  }
  for (const w of (weeks ?? []) as any[]) {
    console.log(
      `${w.start_date} | ${w.season_key} W${w.week_number} | uws=${counts.get(w.start_date) ?? 0} | published=${w.result_published_at ? "Y" : "N"}`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
