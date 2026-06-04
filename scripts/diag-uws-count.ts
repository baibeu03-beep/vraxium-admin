import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { count: total } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true });
  console.log("total:", total);
  for (const s of ["success", "fail", "personal_rest", "official_rest"]) {
    const { count } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true }).eq("status", s);
    console.log(s, count);
  }
  // updated_at 오늘 이전 row 존재?
  const { count: old } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true }).lt("updated_at", "2026-06-04T00:00:00Z");
  console.log("updated before 2026-06-04:", old);
  const { count: today0106 } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true }).gte("updated_at", "2026-06-04T01:00:00Z").lt("updated_at", "2026-06-04T01:10:00Z");
  console.log("updated 01:00~01:10 today:", today0106);
}
main();
