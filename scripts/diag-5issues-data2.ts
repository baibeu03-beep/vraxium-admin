// 평판/동료 전 주차 + snapshot 구조 진단 (이슈4/5 후속)
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 받은 평판 전 주차
  const { data: repsIn } = await sb
    .from("weekly_reputations")
    .select("id, reviewer_id, target_user_id, week_card_id, rating, keyword, created_at")
    .eq("target_user_id", UID)
    .order("created_at");
  console.log(`=== 받은 평판 (${(repsIn ?? []).length}건) ===`);
  for (const r of repsIn ?? []) console.log(r.week_card_id, "reviewer=", r.reviewer_id, r.rating, r.created_at);

  // 작성한 평판 전 주차
  const { data: repsOut } = await sb
    .from("weekly_reputations")
    .select("id, reviewer_id, target_user_id, week_card_id, rating, created_at")
    .eq("reviewer_id", UID)
    .order("created_at");
  console.log(`\n=== 작성한 평판 (${(repsOut ?? []).length}건) ===`);
  for (const r of repsOut ?? []) console.log(r.week_card_id, "target=", r.target_user_id, r.rating, r.created_at);

  // 연계 동료 전 주차 (작성)
  const { data: colsOut } = await sb
    .from("weekly_colleagues")
    .select("id, week_card_id, colleague_id, rank, created_at")
    .eq("user_id", UID)
    .order("created_at");
  console.log(`\n=== 작성한 연계동료 (${(colsOut ?? []).length}건) ===`);
  for (const c of colsOut ?? []) console.log(c.week_card_id, "colleague=", c.colleague_id, "rank", c.rank, c.created_at);

  // 관련 프로필 요약
  const ids = Array.from(new Set([
    ...(repsIn ?? []).map((r: any) => r.reviewer_id),
    ...(colsOut ?? []).map((c: any) => c.colleague_id),
  ]));
  if (ids.length) {
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id, display_name, profile_photo_url, school_name, department_name, profile_tagline, profile_keyword, vision, current_team_name, current_part_name")
      .in("user_id", ids);
    console.log("\n=== 관련 프로필 ===");
    for (const p of profs ?? []) {
      console.log(`${p.display_name} (${p.user_id.slice(0, 8)}) photo=${p.profile_photo_url ? "있음" : "없음"} school=${p.school_name} dept=${p.department_name} tagline=${p.profile_tagline} keyword=${p.profile_keyword} team=${p.current_team_name} part=${p.current_part_name}`);
    }
    const { data: mems } = await sb
      .from("user_memberships")
      .select("user_id, team_name, part_name, membership_level, is_current")
      .in("user_id", ids);
    console.log("memberships:", JSON.stringify(mems));
    const { data: edus } = await sb
      .from("user_educations")
      .select("user_id, school_name, major_name_1")
      .in("user_id", ids);
    console.log("educations:", JSON.stringify(edus));
  }

  // snapshot 구조 — cluster4_weekly_card_snapshots
  const { data: snapRows, error: snapErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("week_id, dto_version, is_stale, computed_at")
    .eq("user_id", UID)
    .order("computed_at", { ascending: false })
    .limit(40);
  console.log(`\n=== cluster4_weekly_card_snapshots (${(snapRows ?? []).length}행) ===`, snapErr?.message ?? "");
  for (const s of snapRows ?? []) console.log(s.week_id, "v" + s.dto_version, "stale=" + s.is_stale, s.computed_at);

  // 평판/동료가 있는 주차의 snapshot payload 확인
  const weekIds = Array.from(new Set([
    ...(repsIn ?? []).map((r: any) => r.week_card_id),
    ...(colsOut ?? []).map((c: any) => c.week_card_id),
  ]));
  for (const wid of weekIds.slice(0, 4)) {
    const { data: s } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version, is_stale, payload")
      .eq("user_id", UID)
      .eq("week_id", wid)
      .maybeSingle();
    if (!s) { console.log(`\nsnapshot ${wid}: 없음`); continue; }
    const p: any = s.payload;
    console.log(`\nsnapshot ${wid} v${s.dto_version} stale=${s.is_stale}`);
    console.log(" weeklyReputations:", JSON.stringify((p?.weeklyReputations ?? []).map((r: any) => ({
      from: r.fromProfile?.name,
      fromImg: r.fromProfile?.profileImageUrl ? r.fromProfile.profileImageUrl.slice(-35) : null,
      to: r.toProfile?.name,
    }))));
    console.log(" weeklyColleagues:", JSON.stringify((p?.weeklyColleagues ?? []).map((c: any) => ({
      name: c.colleagueProfile?.name, school: c.colleagueProfile?.school, team: c.colleagueProfile?.team,
      part: c.colleagueProfile?.part, img: c.colleagueProfile?.profileImageUrl ? "있음" : "없음", tagline: c.colleagueProfile?.profileTagline,
    }))));
  }

  // 주차 id → 주차번호 매핑 (가독)
  if (weekIds.length) {
    const { data: weeks } = await sb.from("weeks").select("id, week_number, season_key, start_date").in("id", weekIds);
    console.log("\nweeks:", JSON.stringify(weeks));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
