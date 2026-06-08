/** 1092 카드 37장 구성 분석 (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

async function main() {
  const cards = (await getCluster4WeeklyCardsForProfileUser("14f5c826-b2cf-4a88-abda-7168f3be907d")) as any[];
  console.log("카드 총", cards.length, "장");
  const dist: Record<string, number> = {};
  for (const c of cards) dist[c.userWeekStatus ?? "(없음)"] = (dist[c.userWeekStatus ?? "(없음)"] ?? 0) + 1;
  console.log("상태 분포:", JSON.stringify(dist));
  console.log("uws 없는(비 success/fail) 카드:");
  for (const c of cards.filter((x) => !["success", "fail"].includes(x.userWeekStatus)))
    console.log(" ", c.startDate, c.seasonKey, "W" + c.weekNumber, "→", c.userWeekStatus, "|", c.statusLabel);
  const acc = Math.max(...cards.map((c) => c.accumulatedApprovedWeeks ?? 0));
  console.log("카드 표시 누적(max accumulatedApprovedWeeks):", acc);
}
main().catch((e) => { console.error(e); process.exit(1); });
