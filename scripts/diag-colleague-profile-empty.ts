/**
 * weeklyColleagues[].colleagueProfile 인적사항 누락 진단.
 * 1) "권태현" user_profiles 탐색
 * 2) 그가 colleague_id 로 지목된 weekly_colleagues 행 → 카드 주인(user_id)/week_card_id
 * 3) 원장 조회: user_profiles / user_educations / user_memberships / legacy_crew_import
 * 4) direct DTO: fetchWeeklyPeopleByWeek(owner, [week]) → colleagueProfile
 */
import { createClient } from "@supabase/supabase-js";
import { fetchWeeklyPeopleByWeek } from "@/lib/cluster4WeeklyPeopleData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const NAME = process.env.DIAG_NAME ?? "권태현";

async function dumpLedger(userId: string, label: string) {
  console.log(`\n── 원장 [${label}] user_id=${userId} ──`);
  const [p, edu, mem, u] = await Promise.all([
    sb
      .from("user_profiles")
      .select(
        "user_id,display_name,gender,birth_date,school_name,department_name,profile_photo_url,profile_tagline,organization_slug",
      )
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("user_educations")
      .select("school_name,major_name_1,sort_order,is_primary,updated_at")
      .eq("user_id", userId),
    sb
      .from("user_memberships")
      .select("team_name,part_name,membership_level,membership_state,is_current,updated_at")
      .eq("user_id", userId),
    sb.from("users").select("id,legacy_user_id").eq("id", userId).maybeSingle(),
  ]);
  console.log("user_profiles:", JSON.stringify(p.data), p.error?.message ?? "");
  console.log("user_educations:", JSON.stringify(edu.data), edu.error?.message ?? "");
  console.log("user_memberships:", JSON.stringify(mem.data), mem.error?.message ?? "");
  const legacyId = (u.data as { legacy_user_id?: unknown } | null)?.legacy_user_id;
  console.log("users.legacy_user_id:", legacyId ?? null, u.error?.message ?? "");
  if (legacyId != null) {
    const leg = await sb
      .from("legacy_crew_import")
      .select("school_name,major_name,team_name,part_name,membership_level,membership_state")
      .eq("legacy_user_id", String(legacyId))
      .maybeSingle();
    console.log("legacy_crew_import:", JSON.stringify(leg.data), leg.error?.message ?? "");
  }
}

async function main() {
  const { data: profiles, error } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", `%${NAME}%`);
  if (error) throw error;
  console.log(`'${NAME}' 매칭 프로필:`, JSON.stringify(profiles));
  if (!profiles?.length) return;

  for (const prof of profiles as { user_id: string; display_name: string }[]) {
    const colId = prof.user_id;
    const { data: colRows } = await sb
      .from("weekly_colleagues")
      .select("id,user_id,week_card_id,colleague_id,rank")
      .eq("colleague_id", colId)
      .limit(5);
    if (!colRows?.length) {
      console.log(`\n[${prof.display_name}] colleague_id 로 지목된 weekly_colleagues 없음`);
      continue;
    }
    console.log(`\n========== [${prof.display_name}] colleague 카드 ${colRows.length}건 ==========`);
    await dumpLedger(colId, `colleague=${prof.display_name}`);

    const owner = (colRows[0] as { user_id: string }).user_id;
    const week = (colRows[0] as { week_card_id: string }).week_card_id;
    console.log(`\n── direct DTO: owner=${owner} week_card_id=${week} ──`);
    const map = await fetchWeeklyPeopleByWeek(owner, [week]);
    const wp = map.get(week);
    const match = wp?.weeklyColleagues.find((c) => c.colleagueUserId === colId);
    console.log("colleagueProfile:", JSON.stringify(match?.colleagueProfile, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
