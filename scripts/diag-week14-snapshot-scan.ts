/**
 * cluster4_weekly_card_snapshots 에 저장된 카드 중 "14주차(2026-spring)" 카드가
 * 개설처럼 보이는 라인(mainTitle 또는 lineTargetId 존재)을 담고 있는지 스캔.
 *   npx tsx --env-file=.env.local scripts/diag-week14-snapshot-scan.ts
 *
 * 라이브 재계산은 14주차에 라인을 0개 내리지만(휴식·target 0), 조회 API 는 snapshot-only.
 * → 과거 시점(휴식 재분류 전 / target 존재 시점)에 저장된 stale snapshot 이 원인인지 확인.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

type LineLike = {
  partType?: string;
  status?: string;
  enhancementStatus?: string;
  lineTargetId?: string | null;
  mainTitle?: string | null;
  lineCode?: string | null;
};
type CardLike = {
  weekId?: string | null;
  seasonKey?: string | null;
  weekNumber?: number | null;
  resultStatus?: string;
  isRestWeek?: boolean;
  lines?: LineLike[];
};

async function main() {
  const WK14_WEEK_ID = "286ddd42-aa7c-4df8-bcff-c7c1a9f5425e"; // 2026-spring wk14
  const pageSize = 500;
  let from = 0;
  let scanned = 0;
  let hits = 0;

  console.log("DTO_VERSION(current) =", WEEKLY_CARDS_DTO_VERSION);
  console.log("scanning cluster4_weekly_card_snapshots ...\n");

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards,dto_version,is_stale,computed_at")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("read error:", error.message);
      break;
    }
    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows as {
      user_id: string;
      cards: unknown;
      dto_version: number;
      is_stale: boolean;
      computed_at: string;
    }[]) {
      scanned++;
      if (!Array.isArray(row.cards)) continue;
      const cards = row.cards as CardLike[];
      const wk14 = cards.find(
        (c) =>
          c.weekId === WK14_WEEK_ID ||
          (c.seasonKey === "2026-spring" && c.weekNumber === 14),
      );
      if (!wk14 || !Array.isArray(wk14.lines)) continue;
      const openedLooking = wk14.lines.filter(
        (l) => (l.mainTitle != null && l.mainTitle !== "") || l.lineTargetId != null,
      );
      if (openedLooking.length > 0) {
        hits++;
        console.log(
          `HIT user=${row.user_id} dto_version=${row.dto_version} is_stale=${row.is_stale} computed_at=${row.computed_at}`,
        );
        console.log(
          `   wk14: resultStatus=${wk14.resultStatus} isRestWeek=${wk14.isRestWeek} openedLines=${openedLooking.length}`,
        );
        for (const l of openedLooking) {
          console.log(
            `     - part=${l.partType} status=${l.status} enh=${l.enhancementStatus} lineTargetId=${l.lineTargetId ?? "null"} lineCode=${l.lineCode ?? "-"} mainTitle=${JSON.stringify(l.mainTitle)}`,
          );
        }
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  console.log(`\nscanned=${scanned} snapshots, week14-opened-looking HITS=${hits}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
