/** 1092 — 카드 lightning(−pen) vs uwp.penalty 주차 단위 대조 (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const UUID = "14f5c826-b2cf-4a88-abda-7168f3be907d";

async function main() {
  const { data: uwp } = await sb
    .from("user_weekly_points")
    .select("week_start_date,penalty,advantages,points")
    .eq("user_id", UUID).neq("week_start_date", "1900-01-01")
    .order("week_start_date").range(0, 999);
  const cards = (await getCluster4WeeklyCardsForProfileUser(UUID)) as any[];
  const cardByStart = new Map(cards.map((c) => [c.startDate, c]));
  let cardSum = 0, dbSum = 0, missingSum = 0;
  console.log("주차".padEnd(12), "| uwp.pen | 카드 lightning | 카드상태");
  for (const r of (uwp ?? []) as any[]) {
    dbSum += r.penalty;
    const c = cardByStart.get(r.week_start_date);
    const cardPen = c?.points?.lightning != null ? -c.points.lightning : null;
    if (c) cardSum += cardPen ?? 0;
    if (!c || cardPen !== r.penalty) {
      missingSum += r.penalty - (c ? (cardPen ?? 0) : 0);
      console.log(
        r.week_start_date.padEnd(12), "|", String(r.penalty).padStart(7), "|",
        c ? String(cardPen).padStart(13) : "카드 없음".padStart(11), "|",
        c ? `${c.seasonKey} W${c.weekNumber} ${c.userWeekStatus}` : "(카드 범위 밖)",
      );
    }
  }
  console.log(`\nΣ uwp.pen=${dbSum} | Σ 카드 lightning=${cardSum} | 누락/불일치 합=${missingSum}`);
  // 카드에만 있고 uwp 없는 주차의 lightning(있으면 안 됨)
  const uwpStarts = new Set(((uwp ?? []) as any[]).map((r) => r.week_start_date));
  for (const c of cards) {
    if (!uwpStarts.has(c.startDate) && c.points?.lightning != null && c.points.lightning !== 0)
      console.log("카드에만 lightning:", c.startDate, c.points.lightning);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
