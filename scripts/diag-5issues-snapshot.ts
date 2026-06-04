// W13 snapshot 평판/동료 + direct 함수 비교 (이슈4/5)
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const W13_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: snap, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version, is_stale, computed_at, card_count, cards")
    .eq("user_id", UID)
    .maybeSingle();
  if (error) throw error;
  if (!snap) { console.log("snapshot 행 없음"); return; }
  console.log("dto_version:", snap.dto_version, "is_stale:", snap.is_stale, "computed_at:", snap.computed_at, "card_count:", snap.card_count);

  const cards = (snap.cards ?? []) as any[];
  const w13 = cards.find((c) => c.weekId === W13_ID || c.id === W13_ID);
  if (!w13) {
    console.log("W13 카드 미발견. 카드 식별자 샘플:", JSON.stringify(cards.slice(0, 2).map((c) => Object.keys(c))));
    return;
  }
  console.log("\nW13 card keys:", Object.keys(w13).join(", "));
  console.log("\nweeklyReputations:", JSON.stringify(w13.weeklyReputations, null, 1)?.slice(0, 3000));
  console.log("\nweeklyColleagues:", JSON.stringify(w13.weeklyColleagues, null, 1)?.slice(0, 3000));
  console.log("\nreputationSummary:", JSON.stringify(w13.reputationSummary));
  console.log("colleagueSummary:", JSON.stringify(w13.colleagueSummary));

  // direct 함수 결과 비교
  const { fetchWeeklyPeopleByWeek } = await import("../lib/cluster4WeeklyPeopleData");
  const direct = await fetchWeeklyPeopleByWeek(UID, [W13_ID]);
  const d = direct.get(W13_ID);
  console.log("\n=== direct fetchWeeklyPeopleByWeek(W13) ===");
  console.log("weeklyReputations:", JSON.stringify(d?.weeklyReputations?.map((r: any) => ({
    from: r.fromProfile?.name, fromImg: r.fromProfile?.profileImageUrl?.slice(-35),
    to: r.toProfile?.name, toImg: r.toProfile?.profileImageUrl?.slice(-35),
  }))));
  console.log("weeklyColleagues:", JSON.stringify(d?.weeklyColleagues?.map((c: any) => ({
    name: c.colleagueProfile?.name, school: c.colleagueProfile?.school, dept: c.colleagueProfile?.department,
    team: c.colleagueProfile?.team, part: c.colleagueProfile?.part,
    img: c.colleagueProfile?.profileImageUrl ? "있음" : "없음", tagline: c.colleagueProfile?.profileTagline,
  }))));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
