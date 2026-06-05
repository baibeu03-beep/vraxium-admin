import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from("user_week_statuses").select("user_id,status")
    .eq("week_start_date", "2026-05-18").eq("user_id", "bf3b4305-751a-49e3-88ad-95a20e5c4dad");
  console.log("T윤도현 w12 uws:", JSON.stringify(data));
  // official_rest stale 보유 테스터 1명 확보
  const { data: any1 } = await sb.from("user_week_statuses").select("user_id")
    .eq("week_start_date", "2026-05-18").eq("status", "official_rest").limit(3);
  console.log("w12 official_rest 보유 유저:", JSON.stringify(any1));
}
main().catch((e) => { console.error(e); process.exit(1); });
