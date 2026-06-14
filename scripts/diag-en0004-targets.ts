import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id,team_id,is_active,created_at").eq("part_type","experience").eq("line_code","EXOK-EN0004");
  console.log("EXOK-EN0004 개설 라인:", (lines??[]).length);
  for (const l of (lines??[]) as any[]) {
    const { data: team } = await sb.from("cluster4_teams").select("team_name,organization_slug").eq("id", l.team_id).maybeSingle();
    const { data: tgts } = await sb.from("cluster4_line_targets").select("target_user_id,week_id").eq("line_id", l.id);
    console.log(`  line=${l.id.slice(0,8)} active=${l.is_active} team="${(team as any)?.team_name}"(${(team as any)?.organization_slug}) targets=${(tgts??[]).length}`);
    for (const t of (tgts??[]) as any[]) {
      const { data: prof } = await sb.from("user_profiles").select("display_name").eq("id", t.target_user_id).maybeSingle();
      const { data: mk } = await sb.from("test_user_markers").select("user_id").eq("user_id", t.target_user_id).maybeSingle();
      console.log(`     target=${t.target_user_id.slice(0,8)} name="${(prof as any)?.display_name}" test_marker=${!!mk}`);
    }
  }
  // 현재 EXOK-EN0004 라인을 포함한 snapshot(고객 소비) 존재 여부
  const ids = (lines??[]).map((l:any)=>l.id);
  if (ids.length) {
    const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale").limit(5);
    console.log("  (snapshot 테이블 샘플 존재 확인용 rows:", (snaps??[]).length, ")");
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
