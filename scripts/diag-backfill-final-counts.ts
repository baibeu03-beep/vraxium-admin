import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
async function main() {
  const { count: lines } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true })
    .eq("source_file_name", "tester-backfill-20260604");
  // 백필 타깃 = 오늘 created, created_by=admin, 테스터 대상
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((mk ?? []).map((m: any) => m.user_id));
  let all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("cluster4_line_targets")
      .select("id, target_user_id, week_id, created_at")
      .gte("created_at", "2026-06-04T02:00:00Z")
      .range(from, from + 999);
    all = all.concat(data ?? []);
    if (!data || data.length < 1000) break;
  }
  const backfill = all.filter((t) => testers.has(t.target_user_id));
  const users = new Set(backfill.map((t) => t.target_user_id));
  const weeks = new Set(backfill.map((t) => t.week_id));
  console.log("최종 백필 라인:", lines, "| 타깃:", backfill.length, "| 테스터:", users.size, "| 주차:", weeks.size);
  console.log("비테스터 타깃(오염 검사):", all.length - backfill.length);
}
main();
