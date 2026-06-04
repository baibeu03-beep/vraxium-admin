/** 테스터(test_user_markers) 90명 snapshot 재계산 — 실유저 비대상. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const ids = (mk ?? []).map((m: any) => m.user_id);
  console.log("재계산 대상(테스터):", ids.length);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 4 });
  console.log("결과:", JSON.stringify(res));
}
main();
