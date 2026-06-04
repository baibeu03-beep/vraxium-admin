// 29→30주차 전환 검증 1단계: weeks 테이블 numbering 확인 + direct 주차 계산
import { createClient } from "@supabase/supabase-js";
import { describeCurrentWeek } from "../lib/cluster4WeekPolicy";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // 1) weeks 테이블: 오늘 전후 행
  const { data: weeks, error } = await sb
    .from("weeks")
    .select("id, season_key, week_number, start_date, end_date, status, is_official_rest")
    .gte("start_date", "2026-05-11")
    .lte("start_date", "2026-06-22")
    .order("start_date");
  if (error) console.error("weeks err:", error.message);
  console.log("=== weeks 테이블 (2026-05-11 ~ 2026-06-22 시작 주차) ===");
  for (const w of weeks ?? []) {
    console.log(
      `  ${w.start_date}~${w.end_date} season=${w.season_key} week_number=${w.week_number} status=${w.status} rest=${w.is_official_rest} id=${String(w.id).slice(0, 8)}`,
    );
  }

  // 혹시 week_number 가 29/30 인 행이 있는지 전역 검색
  const { data: w2930 } = await sb
    .from("weeks")
    .select("id, season_key, week_number, start_date, end_date, status")
    .in("week_number", [29, 30])
    .order("start_date");
  console.log("\n=== week_number IN (29,30) 행 ===");
  for (const w of w2930 ?? []) {
    console.log(
      `  ${w.start_date}~${w.end_date} season=${w.season_key} week_number=${w.week_number} status=${w.status}`,
    );
  }

  // 2) direct 함수: 날짜별 현재 주차
  console.log("\n=== describeCurrentWeek (direct, seasonCalendar 기반) ===");
  for (const d of ["2026-06-04", "2026-06-07", "2026-06-08", "2026-06-14", "2026-06-15"]) {
    const w = describeCurrentWeek(d);
    console.log(
      `  today=${d} → ${w?.seasonKey} ${w?.weekNumber}주차 (${w?.weekStart}~${w?.weekEnd}) officialRest=${w?.isOfficialRest}`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
