import { config } from "dotenv";
config({ path: ".env.local" });
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const U = "28c60d60-aa17-4614-9127-fd65a8aebcaf"; // T송하린
async function main() {
  const snap: any = await readWeeklyCardsSnapshot(U);
  const cards: any[] = snap?.cards ?? [];
  console.log("snapshot status:", snap?.status, "cards:", cards.length);
  for (const c of cards) {
    const infoLines = (c.lines ?? []).filter((l: any) => l.partType === "info");
    console.log(
      `${c.startDate} ${c.weekLabel} | ${c.userWeekStatus} | den=${c.growthDenominator} num=${c.growthNumerator} | info칸=${infoLines.length} ${infoLines.map((l: any) => `[${l.status}/${l.enhancementStatus}${l.lineTargetId ? "·본인배정" : ""}]`).join("")}`
    );
  }
  const dto = await getCluster1Resume(U);
  console.log("\nresume.practicalStats:", JSON.stringify(dto?.practicalStats));
  console.log("resume.activityCompletion:", JSON.stringify(dto?.activityCompletion));
  console.log("resume.seasonRecords:", JSON.stringify(dto?.seasonRecords));
}
main();
