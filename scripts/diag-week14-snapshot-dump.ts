/**
 * 샘플 snapshot 에서 12/13/14주차 카드의 라인 요약을 덤프.
 *   npx tsx --env-file=.env.local scripts/diag-week14-snapshot-dump.ts [limit]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
  startDate?: string;
  lines?: LineLike[];
};

function summarizeCard(c: CardLike | undefined): string {
  if (!c) return "(no card)";
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const opened = lines.filter(
    (l) => (l.mainTitle != null && l.mainTitle !== "") || l.lineTargetId != null,
  );
  const parts = lines
    .map(
      (l) =>
        `${l.partType}:${l.status}/${l.enhancementStatus}${l.mainTitle ? `("${l.mainTitle}")` : ""}${l.lineTargetId ? "[assigned]" : ""}`,
    )
    .join(", ");
  return `start=${c.startDate} wk=${c.weekNumber} result=${c.resultStatus} rest=${c.isRestWeek} | openedLooking=${opened.length} | lines=[${parts}]`;
}

async function main() {
  const limit = Number(process.argv[2] ?? 5);
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,dto_version,is_stale,computed_at")
    .order("computed_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const row of (data ?? []) as {
    user_id: string;
    cards: CardLike[];
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
  }[]) {
    const cards = Array.isArray(row.cards) ? row.cards : [];
    const spring = cards.filter((c) => c.seasonKey === "2026-spring");
    console.log(
      `\n=== user=${row.user_id} dto=${row.dto_version} stale=${row.is_stale} computed=${row.computed_at} | springCards=${spring.length} ===`,
    );
    for (const wk of [12, 13, 14, 15]) {
      const c = cards.find(
        (x) => x.seasonKey === "2026-spring" && x.weekNumber === wk,
      );
      console.log(`  wk${wk}: ${summarizeCard(c)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
