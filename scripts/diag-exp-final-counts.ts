import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const MARKER = "tester-experience-success-backfill-v13-20260604";
async function main() {
  const { count: lines } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("source_file_name", MARKER);
  const { data: mkLines } = await sb.from("cluster4_lines").select("id").eq("source_file_name", MARKER);
  const lineIds = (mkLines ?? []).map((l: any) => l.id);
  let tCount = 0; const userWeeks = new Map<string, Set<string>>(); let nonTester = 0;
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((mk ?? []).map((m: any) => m.user_id));
  for (let i = 0; i < lineIds.length; i += 40) {
    const { data } = await sb.from("cluster4_line_targets").select("target_user_id, week_id").in("line_id", lineIds.slice(i, i + 40));
    for (const t of (data ?? []) as any[]) {
      tCount++;
      if (!testers.has(t.target_user_id)) nonTester++;
      if (!userWeeks.has(t.target_user_id)) userWeeks.set(t.target_user_id, new Set());
      userWeeks.get(t.target_user_id)!.add(t.week_id);
    }
  }
  // 테스터 success 주차 분포 (전체 — 백필 후)
  let all: any[] = [];
  const tArr = [...testers];
  for (let i = 0; i < tArr.length; i += 30) {
    const { data } = await sb.from("user_week_statuses").select("user_id").in("user_id", tArr.slice(i, i + 30)).eq("status", "success");
    all = all.concat(data ?? []);
  }
  const succBy = new Map<string, number>();
  for (const r of all) succBy.set(r.user_id, (succBy.get(r.user_id) ?? 0) + 1);
  const dist = new Map<number, number>();
  for (const id of tArr) {
    const n = succBy.get(id) ?? 0;
    dist.set(n, (dist.get(n) ?? 0) + 1);
  }
  const counts = tArr.map((id) => succBy.get(id) ?? 0).sort((a, b) => a - b);
  console.log("마커 라인:", lines, "| 마커 타깃:", tCount, "| 배정 테스터:", userWeeks.size, "| 비테스터 타깃:", nonTester);
  console.log("테스터 누적 success 주차 분포 (주차→명):", JSON.stringify(Object.fromEntries([...dist.entries()].sort((a, b) => a[0] - b[0]))));
  console.log("min/median/max:", counts[0], counts[Math.floor(counts.length / 2)], counts[counts.length - 1], "| 총 success:", counts.reduce((a, b) => a + b, 0));
}
main();
