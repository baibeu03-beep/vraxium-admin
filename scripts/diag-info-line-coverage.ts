import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id, part_type, week_id, period_label, source_type, is_active, submission_opens_at, submission_closes_at, activity_type_id, main_title, is_recurring_content")
    .eq("part_type", "info").not("week_id", "is", null).order("submission_opens_at");
  const byWeek = new Map<string, any[]>();
  for (const l of (lines ?? []) as any[]) {
    const arr = byWeek.get(l.week_id) ?? [];
    arr.push(l);
    byWeek.set(l.week_id, arr);
  }
  const weekIds = [...byWeek.keys()];
  const { data: weeks } = await sb.from("weeks").select("id, start_date, week_number, season_key").in("id", weekIds);
  const wById = new Map((weeks ?? []).map((w: any) => [w.id, w]));
  const sorted = [...byWeek.entries()].sort((a, b) => String((wById.get(a[0]) as any)?.start_date).localeCompare(String((wById.get(b[0]) as any)?.start_date)));
  for (const [wid, arr] of sorted) {
    const w: any = wById.get(wid);
    console.log(`${w?.start_date} ${w?.season_key} w${w?.week_number} | info lines=${arr.length} | ${arr[0].period_label} | sample="${String(arr[0].main_title).slice(0, 30)}" act_type=${arr[0].activity_type_id} recurring=${arr[0].is_recurring_content}`);
  }
  // 후보 주차 (오늘 flip fail, week_start < 2026-05-25) 의 분포와 대조
  const { data: flips } = await sb.from("user_week_statuses")
    .select("user_id, week_start_date")
    .eq("status", "fail")
    .gte("updated_at", "2026-06-04T01:00:00Z").lt("updated_at", "2026-06-04T01:10:00Z")
    .lt("week_start_date", "2026-05-25");
  const flipWeeks = new Map<string, number>();
  for (const f of (flips ?? []) as any[]) flipWeeks.set(f.week_start_date, (flipWeeks.get(f.week_start_date) ?? 0) + 1);
  console.log("\n후보(flip fail, <05-25) 주차별 테스터 수:");
  const startToWeek = new Map((weeks ?? []).map((w: any) => [w.start_date, w]));
  // weeks 테이블 전체로 보강
  const { data: allWeeks } = await sb.from("weeks").select("id, start_date, week_number, season_key");
  const aw = new Map((allWeeks ?? []).map((w: any) => [w.start_date, w]));
  for (const [sd, n] of [...flipWeeks.entries()].sort()) {
    const w: any = aw.get(sd);
    const hasInfo = w && byWeek.has(w.id) ? `info ${byWeek.get(w.id)!.length}개` : "info 없음 ⚠";
    console.log(`  ${sd} ${w?.season_key} w${w?.week_number}: 테스터 ${n}명 | ${hasInfo}`);
  }
  console.log("\n총 후보 row:", (flips ?? []).length);
}
main();
