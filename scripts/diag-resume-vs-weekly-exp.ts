import { createClient } from "@supabase/supabase-js";
import {
  fetchLineSuccessCountsByWeek,
  fetchWeeklyCardLineAggregates,
} from "@/lib/lineAvailability";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const uid = (await sb.from("cluster4_weekly_card_snapshots").select("user_id"))
    .data!.map((u:any)=>u.user_id).find((id:string)=>id.startsWith("247021bc"))!;
  const { data: uws } = await sb.from("user_week_statuses").select("week_start_date").eq("user_id", uid);
  const starts = (uws??[]).map((w:any)=>w.week_start_date);
  const { data: weeks } = await sb.from("weeks").select("id").in("start_date", starts);
  const weekIds = (weeks??[]).map((w:any)=>w.id);

  // resume 측: rating 필터 없음
  const resumeExpMap = await fetchLineSuccessCountsByWeek(uid, weekIds, "experience");
  let resumeExp = 0; for (const v of resumeExpMap.values()) resumeExp += v;

  // weekly-cards 측: rating<=3 제외
  const agg = await fetchWeeklyCardLineAggregates(uid, weekIds);
  let weeklyExp = 0; for (const v of agg.experienceSuccessMap.values()) weeklyExp += v;

  console.log(`user=247021bc weekIds=${weekIds.length}`);
  console.log(`resume.practicalStats.experienceCount (rating 필터 없음) = ${resumeExp}`);
  console.log(`weekly-cards experience completed 합 (rating<=3 제외)      = ${weeklyExp}`);
  console.log(`불일치? ${resumeExp !== weeklyExp}  (차이 ${resumeExp - weeklyExp})`);
}
main().catch(e=>{console.error(e);process.exit(1);});
