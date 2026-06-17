// 백필: cluster4_roster_card_stats(roster slim 캐시) — 기존 weekly-cards snapshot 카드에서 파생.
//   snapshot(cards/is_stale/dto_version/computed_at)은 일절 건드리지 않는다(읽기만). 1회 실행 권장.
//   마이그레이션(2026-06-17_cluster4_roster_card_stats.sql) 적용 후 실행.
//   npx tsx --env-file=.env.local scripts/backfill-roster-card-stats.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveRosterCardStats } from "@/lib/rosterCardStats";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

async function main() {
  const PAGE = 500;
  let from = 0;
  let scanned = 0;
  let written = 0;
  let skipped = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards,dto_version,computed_at")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      user_id: string;
      cards: unknown;
      dto_version: number;
      computed_at: string;
    }>;

    const upserts: Record<string, unknown>[] = [];
    for (const r of rows) {
      scanned++;
      if (!Array.isArray(r.cards)) {
        skipped++;
        continue;
      }
      // h(elapsed)는 snapshot computed_at 기준(writer 와 동일 — slim 은 snapshot 시점 지표).
      const stats = deriveRosterCardStats(
        r.cards as Cluster4WeeklyCardDto[],
        r.computed_at.slice(0, 10),
      );
      if (!stats) {
        skipped++;
        continue;
      }
      upserts.push({
        user_id: r.user_id,
        dto_version: r.dto_version,
        snapshot_computed_at: r.computed_at,
        success_weeks: stats.successWeeks,
        growable_weeks: stats.growableWeeks,
        elapsed_weeks: stats.elapsedWeeks,
        activity_available: stats.activityAvailable,
        activity_completed: stats.activityCompleted,
        updated_at: new Date().toISOString(),
      });
    }

    if (upserts.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("cluster4_roster_card_stats")
        .upsert(upserts, { onConflict: "user_id" });
      if (upErr) throw new Error(upErr.message);
      written += upserts.length;
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log(`backfill roster slim done: scanned=${scanned} written=${written} skipped=${skipped}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
