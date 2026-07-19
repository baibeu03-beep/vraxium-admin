/**
 * Backfill weekly-card snapshots for encre+oranke+phalanx snapshot-holders after the
 * org-scoped result-publication fix (commit d3f8bc2). The fix changed compute logic but did
 * NOT bump WEEKLY_CARDS_DTO_VERSION, so cron will not auto-recompute already-version-47 rows;
 * this one-shot backfill re-runs getCluster4WeeklyCardsForProfileUser (org-scoped) and upserts.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-org-weekly-card-snapshots.ts          # dry (count only)
 *   npx tsx --env-file=.env.local scripts/backfill-org-weekly-card-snapshots.ts --apply  # recompute+store
 *
 * Safe: per-user failures are isolated (existing snapshot preserved on failure). Read-only for
 *   uws/lines/DTO; only cluster4_weekly_card_snapshots (+ roster slim) is written by the recompute fn.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const ORGS = ["encre", "oranke", "phalanx"];
const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 4;

async function main() {
  // org members
  const { data: profs, error: pe } = await supabaseAdmin
    .from("user_profiles").select("user_id").in("organization_slug", ORGS);
  if (pe) throw new Error("profiles: " + pe.message);
  const orgIds = new Set((profs ?? []).map((p: any) => p.user_id as string));

  // snapshot-holders ∩ org members (paged)
  const holders: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("user_id").order("user_id").range(from, from + 999);
    if (error) throw new Error("snapshots: " + error.message);
    if (!data || data.length === 0) break;
    for (const r of data as any[]) if (orgIds.has(r.user_id)) holders.push(r.user_id);
    if (data.length < 1000) break;
  }
  console.log(`org members=${orgIds.size} | snapshot-holders in orgs=${holders.length} | apply=${APPLY}`);
  if (!APPLY) { console.log("dry-run: pass --apply to recompute."); return; }

  let ok = 0, fail = 0; const failIds: string[] = [];
  let idx = 0;
  async function worker(wid: number) {
    while (idx < holders.length) {
      const i = idx++;
      const uid = holders[i];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        ok++;
      } catch (e) {
        fail++; failIds.push(uid);
        console.warn(`  FAIL ${uid}:`, e instanceof Error ? e.message : e);
      }
      if ((ok + fail) % 25 === 0) console.log(`  progress ${ok + fail}/${holders.length} (ok=${ok} fail=${fail})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  console.log(`\nDONE ok=${ok} fail=${fail}`);
  if (failIds.length) console.log("failed ids:", failIds.slice(0, 30).join(","));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
