/**
 * READ-ONLY 진단2: w12 휴식 오표시 — 중복 weeks 행 + user_week_statuses stale 점검.
 *   npx tsx --env-file=.env.local scripts/diag-rest-week-data2.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const W12_START = "2026-05-18";

async function main() {
  // 1) 같은 날짜 범위를 덮는 weeks 행 전체 (season_key 유무 무관)
  const { data: dupWeeks, error: e1 } = await sb
    .from("weeks")
    .select("id,week_number,season_key,season_id,start_date,end_date,is_official_rest,holiday_name")
    .lte("start_date", W12_START)
    .gte("end_date", W12_START);
  if (e1) throw e1;
  console.log(`weeks rows covering ${W12_START}:`, JSON.stringify(dupWeeks, null, 1));

  // 2) 봄 시즌 전체에서 season_key 없는 weeks 행
  const { data: nokey, error: e2 } = await sb
    .from("weeks")
    .select("id,week_number,season_key,start_date,end_date,is_official_rest")
    .is("season_key", null)
    .gte("start_date", "2026-03-01")
    .lte("start_date", "2026-06-30");
  if (e2) throw e2;
  console.log(`\nseason_key NULL weeks (2026-03~06): ${nokey?.length ?? 0}`,
    JSON.stringify(nokey, null, 1));

  // 3) w12 후보 week id들로 user_week_statuses 분포
  const weekIds = (dupWeeks ?? []).map((w: any) => w.id);
  for (const wid of weekIds) {
    const { data: uws, error: e3 } = await sb
      .from("user_week_statuses")
      .select("user_id,status,is_official_rest,is_resting,published_at")
      .eq("week_id", wid);
    if (e3) { console.log(`uws(${wid}) 에러:`, e3.message); continue; }
    const byStatus = new Map<string, number>();
    let officialRestFlag = 0;
    for (const r of uws ?? []) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      if (r.is_official_rest) officialRestFlag++;
    }
    console.log(`\nuws week_id=${wid}: 총 ${uws?.length}건, status 분포=${JSON.stringify(Object.fromEntries(byStatus))}, is_official_rest=true ${officialRestFlag}건`);
    const restRows = (uws ?? []).filter((r: any) => r.status === "official_rest" || r.is_official_rest);
    if (restRows.length) console.log("  rest 마킹 rows:", JSON.stringify(restRows.slice(0, 10), null, 1));
  }

  // 4) 봄 시즌 비휴식 주차(1~5,9~13) 전체에서 official_rest uws 카운트
  const { data: springWeeks } = await sb
    .from("weeks")
    .select("id,week_number")
    .eq("season_key", "2026-spring")
    .eq("is_official_rest", false);
  const ids = (springWeeks ?? []).map((w: any) => w.id);
  const { data: badUws } = await sb
    .from("user_week_statuses")
    .select("user_id,week_id,status,is_official_rest")
    .in("week_id", ids)
    .or("status.eq.official_rest,is_official_rest.eq.true");
  const byWeek = new Map<string, number>();
  for (const r of badUws ?? []) byWeek.set(r.week_id, (byWeek.get(r.week_id) ?? 0) + 1);
  const wkNum = new Map((springWeeks ?? []).map((w: any) => [w.id, w.week_number]));
  console.log("\n봄 비휴식 주차에 official_rest 마킹된 uws:",
    [...byWeek].map(([id, n]) => `w${wkNum.get(id)}:${n}건`).join(", ") || "없음");
  if (badUws?.length) console.log("  샘플:", JSON.stringify(badUws.slice(0, 15), null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
