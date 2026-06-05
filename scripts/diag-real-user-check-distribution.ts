/**
 * 실사용자 레거시 success 주차의 point.check(user_weekly_points.points) 분포 진단.
 *   npx tsx --env-file=.env.local scripts/diag-real-user-check-distribution.ts
 * read-only.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("user_id,week_start_date,year,week_number,status")
    .lt("week_start_date", "2026-06-29")
    .eq("status", "success")
    .limit(5000);
  const real = (uws ?? []).filter((r: any) => !testers.has(r.user_id));
  const ids = [...new Set(real.map((r: any) => r.user_id))];
  const { data: pts } = await sb
    .from("user_weekly_points")
    .select("user_id,year,week_number,points")
    .in("user_id", ids)
    .limit(5000);
  const byKey = new Map(
    (pts ?? []).map((p: any) => [`${p.user_id}|${p.year}-${p.week_number}`, p.points]),
  );
  const withRow: number[] = [];
  let noRow = 0;
  for (const r of real as any[]) {
    const p = byKey.get(`${r.user_id}|${r.year}-${r.week_number}`);
    if (p == null) noRow++;
    else withRow.push(p);
  }
  withRow.sort((a, b) => a - b);
  console.log(
    `real success weeks: ${real.length} | points row 있음: ${withRow.length} | row 없음: ${noRow}`,
  );
  if (withRow.length) {
    console.log(
      `min/median/max: ${withRow[0]} / ${withRow[Math.floor(withRow.length / 2)]} / ${withRow[withRow.length - 1]}`,
    );
    console.log(`분포: ${JSON.stringify(withRow)}`);
  }
  console.log(`실사용자 수: ${ids.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
