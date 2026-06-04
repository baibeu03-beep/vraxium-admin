import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data, error } = await sb
    .from("weeks")
    .select("season_key,week_number,start_date,end_date")
    .gte("start_date", "2026-02-09")
    .lte("start_date", "2026-03-09")
    .order("start_date");
  if (error) console.log("err:", error.message);
  for (const w of (data ?? []) as any[])
    console.log(w.start_date, "|", w.season_key, "week", w.week_number, "|", w.status);
  const { data: a } = await sb
    .from("weeks")
    .select("season_key,week_number,start_date")
    .eq("start_date", "2025-12-22");
  console.log("2025-12-22 →", JSON.stringify(a));
}
main();
