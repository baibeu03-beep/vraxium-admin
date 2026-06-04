/**
 * READ-ONLY 진단: user_week_statuses(live) vs weekly-cards snapshot 의 주차 status 대조.
 *
 *   npx tsx --env-file=.env.local scripts/diag-resume-vs-snapshot-week-status.ts <userId...>
 *
 * 이력서 카드 누적주차/시즌별 진행주차의 SoT 후보 두 곳이 갈라졌는지 확인:
 *   A) user_week_statuses.status (front /api/profile growthPeriodStats + admin computeSeasonRecords)
 *   B) weekly-cards snapshot 카드 status (허브 화면 표시값)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.log("usage: ... <userId...>");
    process.exit(1);
  }

  for (const userId of ids) {
    const { data: p } = await sb.from("user_profiles").select("display_name").eq("user_id", userId).maybeSingle();
    console.log(`\n════════ ${p?.display_name ?? "?"} (${userId}) ════════`);

    const { data: ws } = await sb
      .from("user_week_statuses")
      .select("week_start_date, status, season_key, week_number")
      .eq("user_id", userId)
      .order("week_start_date", { ascending: true });

    const snap = await readWeeklyCardsSnapshot(userId);
    const cards: any[] = (snap as any)?.cards ?? (Array.isArray(snap) ? snap : []);
    console.log(`snapshot: ${snap ? `cards=${cards.length} stale=${(snap as any)?.isStale ?? "?"} dtoVersion=${(snap as any)?.dtoVersion ?? "?"}` : "null"}`);

    const byStart = new Map<string, any>();
    for (const c of cards) {
      const sd = c.startDate ?? null;
      if (sd) byStart.set(String(sd).slice(0, 10), c);
    }

    console.log("week_start  | live(user_week_statuses) | snapshot userWeekStatus / statusLabel / weekLabel / isTransition");
    for (const r of (ws ?? []) as any[]) {
      const c = byStart.get(String(r.week_start_date).slice(0, 10));
      const cs = c ? `${c.userWeekStatus} / ${c.statusLabel} / ${c.weekLabel} / transition=${c.isTransition}` : "(no card)";
      const mark = c && c.userWeekStatus !== r.status ? "  ⚠ DIVERGED" : "";
      console.log(`${r.week_start_date} | ${String(r.status).padEnd(13)} | ${cs}${mark}`);
    }
    // 카드에는 있는데 live 에 없는 주차
    const liveSet = new Set((ws ?? []).map((r: any) => String(r.week_start_date).slice(0, 10)));
    for (const [sd, c] of byStart) {
      if (!liveSet.has(sd)) console.log(`${sd} | (no live row)   | ${c.userWeekStatus} / ${c.statusLabel} / ${c.weekLabel}  ⚠ CARD-ONLY`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
