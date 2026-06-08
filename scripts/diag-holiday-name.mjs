// 읽기 전용 진단: weeks.holiday_name 보유 현황 (기간 정보 비고 컬럼 데이터 소스 확인)
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.from("weeks").select("season_key,week_number,holiday_name").not("holiday_name", "is", null).order("start_date");
if (error) throw error;
console.log("holiday_name 보유 주차:", data.length);
for (const r of data.slice(0, 10)) console.log(`- ${r.season_key} W${r.week_number}: ${r.holiday_name}`);
