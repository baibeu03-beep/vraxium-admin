/** owner snapshot 의 weeklyColleagues[].colleagueProfile 실제 저장값 + 버전/stale 확인. */
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const OWNER = process.env.DIAG_OWNER ?? "247021bc-374b-48f4-8d49-b181d149ee33";
const WEEK = process.env.DIAG_WEEK ?? "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";

async function main() {
  console.log("현재 코드 WEEKLY_CARDS_DTO_VERSION =", WEEKLY_CARDS_DTO_VERSION);
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at,card_count")
    .eq("user_id", OWNER)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    console.log("snapshot 행 없음 (miss)");
    return;
  }
  console.log("snapshot meta:", JSON.stringify(data));

  const full = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards")
    .eq("user_id", OWNER)
    .maybeSingle();
  const cards = (full.data as { cards: unknown[] } | null)?.cards ?? [];
  const card = (cards as Record<string, unknown>[]).find(
    (c) => c.weekId === WEEK,
  );
  if (!card) {
    console.log(`week ${WEEK} 카드가 snapshot 에 없음. 카드 weekIds:`,
      (cards as Record<string, unknown>[]).map((c) => c.weekId));
    return;
  }
  const wc = (card.weeklyColleagues ?? []) as Record<string, unknown>[];
  console.log(`\nsnapshot week=${WEEK} weeklyColleagues 키 존재? ${"weeklyColleagues" in card}, 건수=${wc.length}`);
  for (const c of wc) {
    console.log("  colleagueProfile:", JSON.stringify(c.colleagueProfile));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
