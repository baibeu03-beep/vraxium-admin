import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 오늘 01:00~01:10 fail 로 갱신된 row 의 user 분포 + display_name
  const { data } = await sb.from("user_week_statuses")
    .select("user_id")
    .gte("updated_at", "2026-06-04T01:00:00Z").lt("updated_at", "2026-06-04T01:10:00Z");
  const ids = [...new Set((data ?? []).map((r: any) => r.user_id))];
  console.log("affected users:", ids.length);
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name").in("user_id", ids);
  const named = (profs ?? []).map((p: any) => p.display_name);
  const tLike = named.filter((n: string) => /t/i.test(n ?? ""));
  console.log("names with t/T:", tLike.length, "/", named.length);
  console.log(JSON.stringify(named.slice(0, 60)));
  // 잔존 success 64건의 user
  const { data: succ } = await sb.from("user_week_statuses").select("user_id, week_start_date").eq("status", "success");
  const succIds = [...new Set((succ ?? []).map((r: any) => r.user_id))];
  const { data: sp } = await sb.from("user_profiles").select("user_id, display_name").in("user_id", succIds);
  console.log("success 보유 유저:", JSON.stringify((sp ?? []).map((p: any) => p.display_name)));
}
main();
