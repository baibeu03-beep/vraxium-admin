// 백필: cluster4_roster_card_stats(roster slim 캐시) — 기존 weekly-cards snapshot 카드 + SoT 에서 파생.
//   성장(a/e/h)·활동완료율 = snapshot 카드 파생. 일정 신뢰도 + Po.A/B/C = live 배치(slim==live 보장).
//   snapshot(cards/is_stale/dto_version/computed_at)은 일절 건드리지 않는다(읽기만). 1회 실행 권장.
//   마이그레이션(2026-06-17_cluster4_roster_card_stats.sql + 2026-06-17_roster_slim_schedule_points.sql)
//   적용 후 실행.  npx tsx --env-file=.env.local scripts/backfill-roster-card-stats.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveRosterCardStats } from "@/lib/rosterCardStats";
import { getScheduleReliabilityRateBatch } from "@/lib/cluster1ResumeData";
import { sumPointsForUsers } from "@/lib/adminMembersData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

async function main() {
  // fat cards jsonb 를 페이지 단위로 읽으므로 크면 statement timeout(원본 500 → 50).
  const PAGE = 50;
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

    // 일정 신뢰도 + Po.A/B/C 는 live 배치로 페이지 단위 일괄 산출(slim==live 보장).
    const pageUserIds = rows.map((r) => r.user_id);
    const [scheduleByUser, pointsByUser] = await Promise.all([
      getScheduleReliabilityRateBatch(pageUserIds),
      sumPointsForUsers(pageUserIds),
    ]);

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
      const pts = pointsByUser.get(r.user_id);
      // base = 성장/활동(마이그레이션 #1) — 항상 존재. 확장 = 일정/포인트(마이그레이션 #2).
      const base = {
        user_id: r.user_id,
        dto_version: r.dto_version,
        snapshot_computed_at: r.computed_at,
        success_weeks: stats.successWeeks,
        growable_weeks: stats.growableWeeks,
        elapsed_weeks: stats.elapsedWeeks,
        activity_available: stats.activityAvailable,
        activity_completed: stats.activityCompleted,
        updated_at: new Date().toISOString(),
      };
      upserts.push({
        ...base,
        schedule_rate: scheduleByUser.get(r.user_id) ?? null,
        po_a: pts?.checkPoints ?? 0,
        po_b: pts?.advantagePoints ?? 0,
        po_c: pts?.penaltyPoints ?? 0,
        _base: base, // 폴백용(아래에서 분리)
      });
    }

    if (upserts.length > 0) {
      const extended = upserts.map(({ _base, ...rest }) => rest);
      const { error: upErr } = await supabaseAdmin
        .from("cluster4_roster_card_stats")
        .upsert(extended, { onConflict: "user_id" });
      if (upErr) {
        // 확장 컬럼 미존재(마이그레이션 #2 미적용, 42703) 등 → base 컬럼만이라도 기록.
        //   성장 slim(getGrowthRosterBatchFast)은 정상 채워지고, 일정/포인트는 읽기에서 live 폴백.
        //   (writeRosterCardStats 와 동일한 graceful 폴백 — slim 무중단·정합.)
        const baseOnly = upserts.map((u) => (u as { _base: Record<string, unknown> })._base);
        const { error: baseErr } = await supabaseAdmin
          .from("cluster4_roster_card_stats")
          .upsert(baseOnly, { onConflict: "user_id" });
        if (baseErr) throw new Error(baseErr.message);
        console.warn(
          `[backfill] 확장 컬럼 미존재 → base-only 기록(일정/포인트는 live 폴백): ${upErr.message}`,
        );
      }
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
