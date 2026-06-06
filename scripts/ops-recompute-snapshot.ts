// ops: weekly-cards snapshot 단건 재계산.
//   npx tsx --env-file=.env.local scripts/ops-recompute-snapshot.ts <userId...>
import { config } from "dotenv";
config({ path: ".env.local" });

import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) throw new Error("usage: ... <userId...>");
  for (const id of ids) {
    await recomputeAndStoreWeeklyCardsSnapshot(id);
    console.log(`recompute 완료: ${id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
