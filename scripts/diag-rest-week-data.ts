/**
 * READ-ONLY 진단: weeks.is_official_rest 실데이터 점검 (봄 시즌 12주차 휴식 오표시).
 *   npx tsx --env-file=.env.local scripts/diag-rest-week-data.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: weeks, error } = await sb
    .from("weeks")
    .select("id,week_number,season_key,start_date,end_date,is_official_rest,holiday_name,iso_year,iso_week")
    .order("start_date", { ascending: true });
  if (error) throw error;

  const rows = (weeks ?? []).filter((w: any) => w.season_key);
  console.log("season_key별 is_official_rest 분포:");
  const bySeason = new Map<string, any[]>();
  for (const w of rows) {
    if (!bySeason.has(w.season_key)) bySeason.set(w.season_key, []);
    bySeason.get(w.season_key)!.push(w);
  }
  for (const [key, ws] of bySeason) {
    const restWeeks = ws.filter((w) => w.is_official_rest).map((w) => `${w.week_number}${w.holiday_name ? `(${w.holiday_name})` : ""}`);
    console.log(`  ${key}: 총 ${ws.length}주 | 공식휴식 주차 = [${restWeeks.join(", ")}]`);
  }

  console.log("\n봄(spring) 시즌 주차 상세:");
  for (const w of rows.filter((x: any) => /spring/i.test(x.season_key))) {
    console.log(`  w${String(w.week_number).padStart(2)} ${w.start_date}~${w.end_date} rest=${w.is_official_rest} holiday=${w.holiday_name ?? "-"} iso=${w.iso_year}/${w.iso_week} id=${w.id}`);
  }

  // official_rest_weeks / official_rest_periods 테이블도 확인
  for (const t of ["official_rest_weeks", "official_rest_periods"]) {
    const { data, error: e } = await sb.from(t).select("*").limit(50);
    console.log(`\n${t}:`, e ? `에러 ${e.message}` : JSON.stringify(data, null, 1));
  }

  // seasons 테이블 (front currentWeek.seasons join 용)
  const { data: seasons } = await sb.from("seasons").select("id,name,year,season_label,season_type").order("year");
  console.log("\nseasons:", JSON.stringify(seasons, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
