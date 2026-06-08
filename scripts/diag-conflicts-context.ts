// read-only: 충돌 주차 맥락 — 2023/2024-autumn 주차 구성, official_rest_weeks 원본, 시즌 정의
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data: sd } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_type,start_date,end_date")
    .in("season_key", ["2023-autumn", "2024-autumn", "2025-winter"]);
  console.log("season_definitions:", JSON.stringify(sd));

  for (const key of ["2023-autumn", "2024-autumn", "2025-winter"]) {
    const { data: w } = await supabaseAdmin
      .from("weeks")
      .select("week_number,start_date,end_date,is_official_rest,holiday_name")
      .eq("season_key", key)
      .order("week_number");
    console.log(`\n${key} weeks (${w?.length}):`);
    for (const r of w ?? [])
      console.log(`  W${String(r.week_number).padStart(2)} ${r.start_date} rest=${r.is_official_rest} holiday=${r.holiday_name ?? ""}`);
  }

  const { data: orw } = await supabaseAdmin.from("official_rest_weeks").select("*").order("year");
  console.log("\nofficial_rest_weeks(전체):", JSON.stringify(orw));
}

main().catch((e) => { console.error(e); process.exit(1); });
