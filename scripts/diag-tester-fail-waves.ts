import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testers = (mk ?? []).map((m: any) => m.user_id);
  // 테스터 fail 행 전체 (paging)
  let all: any[] = [];
  for (let i = 0; i < testers.length; i += 30) {
    const { data } = await sb.from("user_week_statuses")
      .select("user_id, week_start_date, status, updated_at, created_at")
      .in("user_id", testers.slice(i, i + 30))
      .eq("status", "fail");
    all = all.concat(data ?? []);
  }
  console.log("테스터 fail 행 총:", all.length);
  const byDay = new Map<string, number>();
  for (const r of all) {
    const d = String(r.updated_at ?? "").slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log("updated_at 일자별:", JSON.stringify(Object.fromEntries([...byDay.entries()].sort())));
  // created_at 일자별 (seed 시점)
  const byCre = new Map<string, number>();
  for (const r of all) {
    const d = String(r.created_at ?? "").slice(0, 10);
    byCre.set(d, (byCre.get(d) ?? 0) + 1);
  }
  console.log("created_at 일자별:", JSON.stringify(Object.fromEntries([...byCre.entries()].sort())));
  // created==updated (organic seed fail, sync 안 거침)
  const organic = all.filter((r) => r.updated_at === r.created_at);
  console.log("updated==created (organic fail):", organic.length);
  // week_start >= 2026-05-25 (tallying/running 이후) fail
  const recent = all.filter((r) => r.week_start_date >= "2026-05-25");
  console.log("week_start>=2026-05-25 fail:", recent.length);
}
main();
