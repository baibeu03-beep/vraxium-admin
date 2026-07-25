import { loadFinalizedWeeklyCardsReadOnly } from "@/lib/cluster4WeeklyCardsService";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

/**
 * Canonical meaning of weekly counters used by every resume/roster surface.
 * The only result input is the finalized weekly-card snapshot with its
 * read-time enhancement overrides applied by loadFinalizedWeeklyCardsReadOnly.
 */
export type CanonicalWeeklyMetrics = {
  successWeeks: number;
  seasonSuccessWeeks: Record<string, number>;
  elapsedWeeks: number;
  totalScheduledWeeks: number;
  reviewedWeeks: number;
  source: "snapshot" | "snapshot_stale" | "snapshot_miss" | "snapshot_error";
  cards: Cluster4WeeklyCardDto[];
};

function isTransition(card: Cluster4WeeklyCardDto): boolean {
  return Boolean(card.isTransition) ||
    (typeof card.startDate === "string" && isTransitionWeekStart(card.startDate));
}

export function buildCanonicalWeeklyMetrics(
  cards: readonly Cluster4WeeklyCardDto[],
  todayIso: string,
  reviewedByWeekId: ReadonlyMap<string, boolean> = new Map(),
): Omit<CanonicalWeeklyMetrics, "source" | "cards"> {
  const scheduled = cards.filter((card) => !isTransition(card));
  const success = scheduled.filter((card) => card.userWeekStatus === "success");
  const seasonSuccessWeeks: Record<string, number> = {};
  for (const card of success) {
    if (!card.seasonKey) continue;
    seasonSuccessWeeks[card.seasonKey] = (seasonSuccessWeeks[card.seasonKey] ?? 0) + 1;
  }
  return {
    successWeeks: success.length,
    seasonSuccessWeeks,
    elapsedWeeks: scheduled.filter(
      (card) => typeof card.endDate === "string" && card.endDate < todayIso,
    ).length,
    totalScheduledWeeks: scheduled.length,
    reviewedWeeks: scheduled.filter((card) =>
      typeof card.weekId === "string" && reviewedByWeekId.get(card.weekId) === true,
    ).length,
  };
}

async function loadReviewedByWeekId(cards: readonly Cluster4WeeklyCardDto[]) {
  const ids = cards
    .map((card) => card.weekId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return new Map<string, boolean>();
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,result_reviewed_at")
    .in("id", ids);
  if (error) return new Map<string, boolean>();
  return new Map(
    ((data ?? []) as Array<{ id: string; result_reviewed_at: string | null }>).map((row) => [
      row.id,
      row.result_reviewed_at != null,
    ]),
  );
}

export async function resolveCanonicalWeeklyMetrics(
  userId: string,
  todayIso = new Date().toISOString().slice(0, 10),
): Promise<CanonicalWeeklyMetrics> {
  const result = await loadFinalizedWeeklyCardsReadOnly(userId);
  const reviewed = await loadReviewedByWeekId(result.cards);
  const metrics = buildCanonicalWeeklyMetrics(result.cards, todayIso, reviewed);
  return {
    ...metrics,
    source:
      result.outcome === "hit"
        ? "snapshot"
        : result.outcome === "stale"
          ? "snapshot_stale"
          : result.outcome === "miss"
            ? "snapshot_miss"
            : "snapshot_error",
    cards: result.cards,
  };
}

export async function resolveCanonicalWeeklyMetricsBatch(userIds: readonly string[]) {
  const entries = await Promise.all(
    userIds.map(async (userId) => [userId, await resolveCanonicalWeeklyMetrics(userId)] as const),
  );
  return new Map(entries);
}
