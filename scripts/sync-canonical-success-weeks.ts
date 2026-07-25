import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildCanonicalWeeklyMetrics } from "@/lib/canonicalWeeklyMetrics";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

type SnapshotRow = { user_id: string; cards: Cluster4WeeklyCardDto[] };

async function loadSnapshots() {
  const out: SnapshotRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SnapshotRow[]));
    if (!data || data.length < 1000) return out;
  }
}

async function main() {
  if (!process.argv.includes("--apply")) {
    throw new Error("This derived-cache sync is write-protected. Re-run with --apply.");
  }
  const snapshots = await loadSnapshots();
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;
  async function retry<T>(fn: () => Promise<{ error: { message: string } | null }>) {
    let last: { message: string } | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await fn();
      if (!result.error) return;
      last = result.error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw new Error(last?.message ?? "cache update failed");
  }
  for (const row of snapshots) {
    const successWeeks = buildCanonicalWeeklyMetrics(row.cards ?? [], today).successWeeks;
    await retry(() => supabaseAdmin.from("user_growth_stats").update({ approved_weeks: successWeeks }).eq("user_id", row.user_id));
    await retry(() => supabaseAdmin.from("cluster4_roster_card_stats").update({ success_weeks: successWeeks }).eq("user_id", row.user_id));
    updated++;
  }
  console.log(`canonical successWeeks cache sync complete: ${updated} users`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
