/** READ-ONLY 진단: T윤도현(demo) w13 연계동료 — snapshot DTO vs legacy 테이블 vs 동료 프로필. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";

async function main() {
  // 1) snapshot DTO 의 weeklyColleagues
  const { data: snap } = await sb.from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale,computed_at,cards").eq("user_id", UID).maybeSingle();
  const cards = Array.isArray(snap?.cards) ? snap!.cards : [];
  const w13 = cards.find((c: any) => c.weekId === W13 || c.startDate === "2026-05-25");
  console.log(`snapshot v${snap?.dto_version} stale=${snap?.is_stale} computed=${snap?.computed_at}`);
  console.log("w13 weeklyColleagues:", JSON.stringify(w13?.weeklyColleagues ?? null, null, 1)?.slice(0, 2500));
  console.log("w13 weeklyReputations 수:", Array.isArray(w13?.weeklyReputations) ? w13.weeklyReputations.length : null);

  // 2) legacy weekly_colleagues 테이블
  const { data: wc, error: wcErr } = await sb.from("weekly_colleagues")
    .select("*").eq("user_id", UID).eq("week_card_id", W13);
  console.log("\nweekly_colleagues rows:", wcErr ? wcErr.message : JSON.stringify(wc, null, 1)?.slice(0, 1500));

  // 3) 동료들의 프로필/멤버십
  const ids = new Set<string>();
  for (const r of wc ?? []) if (r.colleague_id) ids.add(r.colleague_id);
  for (const c of w13?.weeklyColleagues ?? []) {
    const cid = c?.colleagueProfile?.userId ?? c?.colleagueUserId ?? c?.colleagueId;
    if (cid) ids.add(cid);
  }
  if (ids.size) {
    const idArr = [...ids];
    const { data: profs } = await sb.from("user_profiles")
      .select("user_id,name,school_name,department_name,current_team_name,current_part_name,profile_tagline,profile_keyword,vision,gender,birth_date")
      .in("user_id", idArr);
    console.log("\n동료 user_profiles:", JSON.stringify(profs, null, 1)?.slice(0, 2000));
    const { data: mems } = await sb.from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,membership_state,is_current,updated_at")
      .in("user_id", idArr);
    console.log("\n동료 user_memberships:", JSON.stringify(mems, null, 1)?.slice(0, 2000));
    const { data: tm } = await sb.from("test_user_markers").select("user_id").in("user_id", idArr);
    console.log("\n동료 중 테스터:", (tm ?? []).map((r: any) => r.user_id));
  } else {
    console.log("\n동료 ID 없음");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
