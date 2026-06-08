/**
 * T2 후속 — admin getWeeklyGrowth vs front weekly-growth 주차별 상세 비교(실 필드명).
 *   npx tsx --env-file=.env.local scripts/audit-sot-t2-detail.ts <userId>
 */
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

const uid = process.argv[2] ?? "e4dcb97e-a515-4ec5-a91e-32ca4e629dae";
const FRONT = "https://vraxium.vercel.app";

async function main() {
  const [direct, frontRes] = await Promise.all([
    getWeeklyGrowth(uid),
    fetch(`${FRONT}/api/cluster4/weekly-growth?userId=${uid}`).then((r) => r.json()),
  ]);

  const dCards = direct?.weeklyCards ?? [];
  const fCards = frontRes?.weeklyCards ?? [];
  console.log("admin card keys:", Object.keys(dCards[0] ?? {}).join(","));
  console.log("front card keys:", Object.keys(fCards[0] ?? {}).join(","));

  const keyOf = (c: any) => c.weekId;
  const norm = (c: any) => ({
    weekNumber: c.weekNumber,
    resultStatus: c.resultStatus ?? null,
    shield: c.points?.shield ?? c.points ?? null,
    acc: c.accumulatedApprovedWeeks ?? null,
  });
  const dMap = new Map(dCards.map((c: any) => [keyOf(c), norm(c)]));
  const fMap = new Map(fCards.map((c: any) => [keyOf(c), norm(c)]));
  const diffs: any[] = [];
  for (const k of new Set([...dMap.keys(), ...fMap.keys()])) {
    const a = dMap.get(k);
    const b = fMap.get(k);
    if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push({ week: k, admin: a ?? "(missing)", front: b ?? "(missing)" });
  }
  console.log(`per-week diffs=${diffs.length}`);
  for (const d of diffs) console.log("  ", JSON.stringify(d));

  console.log("\nadmin growthSummary:", JSON.stringify((direct as any)?.growthSummary));
  console.log("front growthStats  :", JSON.stringify(frontRes?.growthStats));
  console.log("\nadmin seasonSummary:", JSON.stringify((direct as any)?.seasonSummary));
  console.log("front seasonSummary:", JSON.stringify(frontRes?.data?.seasonSummary));
  console.log(
    "\nadmin seasonPointSummary:",
    JSON.stringify((direct as any)?.seasonPointSummary),
  );
  console.log("front seasonPointSummary:", JSON.stringify(frontRes?.data?.seasonPointSummary));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
