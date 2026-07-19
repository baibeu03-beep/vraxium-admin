/**
 * Re-recompute (in-process, gated) any org snapshot that still carries a pre-2026-summer
 * "검수 중"(reviewing) card — the legacy-pollution side effect that the source==='organization'
 * gate removes. Runs the compute directly (no dev-server), so it can't be clobbered by a stale
 * dev-server module. Loops until the fleet is clean or maxPasses reached.
 *
 *   npx tsx --env-file=.env.local scripts/fix-legacy-reviewing-stragglers.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const ORGS = ["encre", "oranke", "phalanx"];

async function orgHolderIds(): Promise<Set<string>> {
  const { data } = await supabaseAdmin.from("user_profiles").select("user_id").in("organization_slug", ORGS);
  return new Set((data ?? []).map((p: any) => p.user_id));
}

async function scanPolluted(orgIds: Set<string>): Promise<string[]> {
  const bad: string[] = [];
  for (let from = 0; ; from += 50) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("user_id,cards").order("user_id").range(from, from + 49);
    if (error) { console.error("scan err", error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      if (!orgIds.has(r.user_id)) continue;
      const cards = Array.isArray(r.cards) ? r.cards : [];
      if (cards.some((c: any) => c.statusLabel === "검수 중" && (c.seasonKey ?? c.season_key) !== "2026-summer")) bad.push(r.user_id);
    }
    if (data.length < 50) break;
  }
  return bad;
}

async function main() {
  const orgIds = await orgHolderIds();
  for (let pass = 1; pass <= 4; pass++) {
    const bad = await scanPolluted(orgIds);
    console.log(`pass ${pass}: polluted users = ${bad.length}`);
    if (bad.length === 0) { console.log("CLEAN"); return; }
    let idx = 0, ok = 0, fail = 0;
    async function worker() {
      while (idx < bad.length) {
        const uid = bad[idx++];
        try { await recomputeAndStoreWeeklyCardsSnapshot(uid); ok++; }
        catch (e) { fail++; console.warn("fail", uid, e instanceof Error ? e.message : e); }
      }
    }
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    console.log(`  recomputed ok=${ok} fail=${fail}`);
  }
  const final = await scanPolluted(orgIds);
  console.log(final.length === 0 ? "CLEAN after passes" : `STILL POLLUTED: ${final.length} (${final.slice(0,10).join(",")})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
