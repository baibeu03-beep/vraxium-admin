import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: weeks } = await sb.from("weeks")
    .select("id, start_date, end_date, week_number, season_key, is_official_rest, result_published_at")
    .order("start_date");
  const byStart = new Map<string, any[]>();
  for (const w of (weeks ?? []) as any[]) {
    const arr = byStart.get(w.start_date) ?? []; arr.push(w); byStart.set(w.start_date, arr);
  }
  let dups = 0;
  for (const [sd, arr] of byStart) {
    if (arr.length > 1) {
      dups++;
      console.log(`DUP ${sd}: ${arr.map((w) => `${w.id.slice(0,8)}(${w.season_key} w${w.week_number} pub=${w.result_published_at ? "Y" : "N"} rest=${w.is_official_rest})`).join("  |  ")}`);
    }
  }
  console.log("중복 start_date 수:", dups, "/ 전체 주차 행:", (weeks ?? []).length);
}
main();
