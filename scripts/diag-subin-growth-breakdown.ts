/** READ-ONLY: T최수빈 weekly-growth 경로 lineBreakdown(experience A/B) — cards 경로와 정합 확인. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

const USER_ID = "36138fb1-6fea-4b22-b6d2-9c46cba47314";

async function main() {
  const growth = await getWeeklyGrowth(USER_ID);
  if (!growth) throw new Error("growth null");
  for (const c of growth.weeklyCards) {
    if (c.weekNumber == null) continue;
    console.log(
      `W${c.weekNumber} (${c.resultStatus}) growth=${c.weeklyGrowth.completedLines}/${c.weeklyGrowth.availableLines}@${c.weeklyGrowth.rate}%`,
      `| exp=${c.lineBreakdown.experience.completed}/${c.lineBreakdown.experience.available}`,
      `| info=${c.lineBreakdown.info.completed}/${c.lineBreakdown.info.available}`,
      `| ability=${c.lineBreakdown.ability.completed}/${c.lineBreakdown.ability.available}`,
      `| career=${c.lineBreakdown.career.completed}/${c.lineBreakdown.career.available}`,
    );
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
