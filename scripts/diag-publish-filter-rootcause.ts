/**
 * READ-ONLY: 0/n 근본원인 확인 — 과거 success 주차가 weeks.result_published_at NULL 로
 *   분자에서 제외되는지 검증.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const uid = "73b3fa9a-e875-43d0-a945-477237eb2f68"; // 윤서영
  const { data: ws } = await sb
    .from("user_week_statuses")
    .select("week_start_date,status,season_key")
    .eq("user_id", uid)
    .order("week_start_date");
  const starts = [...new Set((ws ?? []).map((w: any) => w.week_start_date))];
  const { data: weeks } = await sb
    .from("weeks")
    .select("start_date,result_published_at,season_key")
    .in("start_date", starts);
  const pubByStart = new Map<string, string | null>();
  const existsByStart = new Set<string>();
  for (const w of (weeks ?? []) as any[]) {
    pubByStart.set(w.start_date, w.result_published_at);
    existsByStart.add(w.start_date);
  }
  console.log("윤서영 주차별 publish 상태:");
  for (const w of (ws ?? []) as any[]) {
    const exists = existsByStart.has(w.week_start_date);
    const pub = pubByStart.get(w.week_start_date);
    console.log(
      `  ${w.week_start_date} ${w.status.padEnd(8)} ${w.season_key} | weeks행존재=${exists} published=${pub ?? "(null)"}`,
    );
  }

  // 전역: weeks 테이블의 result_published_at NULL 비율 (시즌별)
  console.log("\n전역 weeks.result_published_at 분포 (start_date 연도별):");
  const allWeeks: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb
      .from("weeks")
      .select("start_date,result_published_at")
      .order("start_date")
      .range(f, f + 999);
    const rows = (data ?? []) as any[];
    allWeeks.push(...rows);
    if (rows.length < 1000) break;
  }
  const byYear = new Map<string, { total: number; pub: number }>();
  for (const w of allWeeks) {
    const y = String(w.start_date).slice(0, 4);
    const e = byYear.get(y) ?? { total: 0, pub: 0 };
    e.total++;
    if (w.result_published_at) e.pub++;
    byYear.set(y, e);
  }
  for (const [y, e] of [...byYear.entries()].sort()) {
    console.log(`  ${y}: 전체 ${e.total} · published ${e.pub} · NULL ${e.total - e.pub}`);
  }
  console.log(`  weeks 총행: ${allWeeks.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
