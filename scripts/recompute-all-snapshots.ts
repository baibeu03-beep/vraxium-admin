/** 전 사용자(snapshot 보유자) weekly-cards snapshot 재계산 — v14.1 placeholder 교정 반영용 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const ids = [...new Set((data ?? []).map((r: any) => r.user_id))];
  console.log("대상:", ids.length);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 4 });
  console.log("결과:", JSON.stringify(res));
}
main();
