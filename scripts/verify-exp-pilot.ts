import { config } from "dotenv";
config({ path: ".env.local" });
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { syncExperienceGrowthWeekStatuses } from "@/lib/cluster4WeeklyGrowthData";

const U = process.argv[2] || "28c60d60-aa17-4614-9127-fd65a8aebcaf"; // T송하린
async function main() {
  const snap: any = await readWeeklyCardsSnapshot(U);
  const cards: any[] = snap?.cards ?? [];
  console.log("snapshot:", snap?.status, "cards:", cards.length);
  for (const c of [...cards].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))) {
    const exp = (c.lines ?? []).filter((l: any) => l.partType === "experience");
    const own = exp.filter((l: any) => l.lineTargetId);
    console.log(
      `${c.startDate} ${c.weekLabel} | ${c.userWeekStatus}/${c.statusLabel} | den=${c.growthDenominator} num=${c.growthNumerator} | exp본인배정=${own.length} [${own.map((l: any) => `s${l.experienceSlotOrder}:${l.enhancementStatus}`).join(",")}]`
    );
  }
  const dto = await getCluster1Resume(U);
  console.log("\nresume.seasonRecords:", JSON.stringify(dto?.seasonRecords));
  console.log("resume.practicalStats:", JSON.stringify(dto?.practicalStats));
  console.log("resume.activityCompletion:", JSON.stringify(dto?.activityCompletion));
  console.log("resume.scheduleReliability:", JSON.stringify(dto?.scheduleReliability));

  // sync 회귀 검사 (dry-run): 백필 주차가 다시 fail 로 안 뒤집히는지
  const sync = await syncExperienceGrowthWeekStatuses(U, { dryRun: true });
  console.log("\nsync dry-run:", JSON.stringify({
    scannedSuccessWeeks: sync.scannedSuccessWeeks,
    flippedToFail: sync.flippedToFail,
    flippedWeekKeys: sync.flippedWeekKeys,
    isTestUser: sync.isTestUser,
  }));
}
main();
