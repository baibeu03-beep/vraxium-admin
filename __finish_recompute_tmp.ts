import { readFileSync } from "node:fs";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  const ids: string[] = JSON.parse(readFileSync("./__forum_recompute_ids.json", "utf8"));
  console.log("recomputing", ids.length, "stale phalanx snapshots...");
  const r = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 4 });
  console.log(JSON.stringify({ requested: r.requested, recomputed: r.recomputed, failed: r.failed, failedUserIds: r.failedUserIds }, null, 2));
  process.exit(r.failed > 0 ? 1 : 0);
}
main();
