/**
 * READ-ONLY 진단: user_week_statuses 전역 status 분포 + 최근 갱신 시각.
 *   npx tsx --env-file=.env.local scripts/diag-week-statuses-global.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // 컬럼 파악
  const { data: sample } = await sb.from("user_week_statuses").select("*").limit(1);
  console.log("columns:", sample && sample[0] ? Object.keys(sample[0]).join(", ") : "(empty)");

  const { data: all, error } = await sb
    .from("user_week_statuses")
    .select("user_id, week_start_date, status, updated_at, created_at")
    .order("updated_at", { ascending: false })
    .limit(3000);
  if (error) {
    console.log("error:", error.message);
    return;
  }
  const rows = all ?? [];
  console.log("total rows fetched:", rows.length);

  const statusDist = new Map<string, number>();
  for (const r of rows as any[]) statusDist.set(r.status, (statusDist.get(r.status) ?? 0) + 1);
  console.log("status 분포:", JSON.stringify(Object.fromEntries(statusDist)));

  // success 가 단 한 건이라도 있는가
  const successRows = (rows as any[]).filter((r) => r.status === "success");
  console.log("success rows:", successRows.length);
  if (successRows.length > 0) console.log("success sample:", JSON.stringify(successRows.slice(0, 5)));

  // 최근 updated_at 상위 — 언제 무엇이 갱신됐나
  console.log("\n최근 updated_at 상위 30:");
  for (const r of (rows as any[]).slice(0, 30)) {
    console.log(`${r.updated_at} | ${r.week_start_date} | ${r.status} | user=${String(r.user_id).slice(0, 8)}`);
  }

  // updated_at 날짜별 카운트
  const byDay = new Map<string, number>();
  for (const r of rows as any[]) {
    const d = String(r.updated_at ?? "").slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log("\nupdated_at 날짜별:", JSON.stringify(Object.fromEntries([...byDay.entries()].sort())));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
