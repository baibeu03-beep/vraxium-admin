import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildCanonicalWeeklyMetrics } from "@/lib/canonicalWeeklyMetrics";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

type SnapshotRow = { user_id: string; cards: Cluster4WeeklyCardDto[] };
type CacheRow = { user_id: string; success_weeks: number | null };

async function allSnapshots(): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as SnapshotRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

async function main() {
  const [snapshots, rosterRes, growthRes] = await Promise.all([
    allSnapshots(),
    supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,success_weeks"),
    supabaseAdmin.from("user_growth_stats").select("user_id,approved_weeks"),
  ]);
  if (rosterRes.error) throw new Error(rosterRes.error.message);
  if (growthRes.error) throw new Error(growthRes.error.message);
  const roster = new Map(((rosterRes.data ?? []) as CacheRow[]).map((r) => [r.user_id, r.success_weeks]));
  const admin = new Map(((growthRes.data ?? []) as Array<{ user_id: string; approved_weeks: number | null }>).map((r) => [r.user_id, r.approved_weeks]));
  const today = new Date().toISOString().slice(0, 10);
  const failures: Array<Record<string, unknown>> = [];
  for (const row of snapshots) {
    const canonical = buildCanonicalWeeklyMetrics(row.cards ?? [], today);
    const seasonTotal = Object.values(canonical.seasonSuccessWeeks).reduce((a, b) => a + b, 0);
    const values = {
      userId: row.user_id,
      canonicalSuccessWeeks: canonical.successWeeks,
      seasonSuccessWeeks: seasonTotal,
      medalSuccessWeeks: canonical.successWeeks,
      // No cache row is equivalent to zero only for a user with no scheduled
      // card; active users must have an explicit synchronized cache value.
      rosterSuccessWeeks: roster.get(row.user_id) ?? (canonical.totalScheduledWeeks === 0 ? 0 : null),
      adminSuccessWeeks: admin.get(row.user_id) ?? (canonical.totalScheduledWeeks === 0 ? 0 : null),
      elapsedWeeks: canonical.elapsedWeeks,
      totalScheduledWeeks: canonical.totalScheduledWeeks,
    };
    const comparable = [values.seasonSuccessWeeks, values.medalSuccessWeeks, values.rosterSuccessWeeks, values.adminSuccessWeeks];
    if (comparable.some((value) => value !== values.canonicalSuccessWeeks)) failures.push(values);
    console.log(JSON.stringify({ ...values, verdict: failures.at(-1)?.userId === row.user_id ? "FAIL" : "OK" }));
  }
  if (failures.length > 0) {
    console.error(`canonical successWeeks audit failed: ${failures.length} users`);
    process.exitCode = 1;
  } else {
    console.log(`canonical successWeeks audit passed: ${snapshots.length} users`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
