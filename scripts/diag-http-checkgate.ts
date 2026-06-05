/**
 * HTTP weekly-cards 응답의 checkGate 페이로드 진단 (A/B 샘플).
 *   npx tsx --env-file=.env.local scripts/diag-http-checkgate.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "fs";

const log = JSON.parse(
  readFileSync("claudedocs/legacy-check-case-seed-20260605.json", "utf-8"),
);

async function main() {
  for (const k of ["A", "B"]) {
    const p = log.plans.find((x: any) => x.case === k);
    const res = await fetch(
      `http://localhost:3000/api/cluster4/weekly-cards?userId=${p.userId}`,
      { headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" } },
    );
    const json = await res.json();
    const card = (json.data ?? []).find((c: any) => c.startDate === p.weekStart);
    console.log(
      k,
      p.userId.slice(0, 8),
      p.weekStart,
      "| status=",
      card?.userWeekStatus,
      "| checkGate=",
      JSON.stringify(card?.experienceGrowth?.checkGate),
      "| growthKeys=",
      card?.experienceGrowth ? Object.keys(card.experienceGrowth).join(",") : null,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
