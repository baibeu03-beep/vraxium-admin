import { config } from "dotenv";
config({ path: ".env.local" });
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
const U = "28c60d60-aa17-4614-9127-fd65a8aebcaf";
async function main() {
  const snap: any = await readWeeklyCardsSnapshot(U);
  const cards: any[] = snap?.cards ?? [];
  const c = cards.find((x: any) => x.startDate === "2026-03-02");
  console.log("week 2026-03-02 lines:");
  for (const l of c?.lines ?? []) {
    console.log(` partType=${l.partType} status=${l.status} enh=${l.enhancementStatus} targetId=${l.lineTargetId ? "Y" : "-"} title="${String(l.mainTitle ?? "").slice(0, 30)}"`);
  }
  const parts = new Set<string>();
  for (const card of cards) for (const l of card.lines ?? []) parts.add(l.partType);
  console.log("distinct partTypes:", [...parts].join(", "));
}
main();
