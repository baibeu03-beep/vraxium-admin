import { config } from "dotenv"; config({ path: ".env.local" });
import { recomputeStaleOrDueSnapshots } from "@/lib/cluster4WeeklyCardsSnapshot";
async function main(){
  // version_mismatch + is_stale 모두 잡힘. due 0 영향 위해 큰 dueOlderThan.
  const res = await recomputeStaleOrDueSnapshots({ maxUsers: 500, dueOlderThanMs: 10*365*24*3600*1000, concurrency: 4 });
  console.log("converge result:", JSON.stringify(res));
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
