// user_growth_stats 전수 재집계 백필 — 주차 SoT 불일치(stale 캐시) 일괄 복구.
// 대상: user_week_statuses 에 row 가 있는 모든 user_id (PostgREST 1000행 캡 → range 페이지네이션).
// 공식: recalcUserGrowthStats (success/전체 카운트, 전환 주차 제외 — 2026-06-04 정책).
// 사용: npx tsx scripts/backfill-growth-stats-recalc-all.ts [--dry-run]
import { config } from "dotenv";
config({ path: ".env.local" });

const DRY_RUN = process.argv.includes("--dry-run");
const PAGE = 1000;

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { recalcUserGrowthStats } = await import("../lib/userGrowthStatsData");

  // 1) uws 보유 user_id 전수 수집 (페이지네이션)
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if ((data ?? []).length < PAGE) break;
  }
  console.log(`대상 사용자: ${ids.size}명 (dryRun=${DRY_RUN})`);

  // 2) 변경 전 캐시 스냅샷 (감사 로그용)
  const before = new Map<string, { approved: number | null; cumulative: number | null }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_growth_stats")
      .select("user_id, approved_weeks, cumulative_weeks")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[])
      before.set(r.user_id, { approved: r.approved_weeks, cumulative: r.cumulative_weeks });
    if ((data ?? []).length < PAGE) break;
  }

  // 3) 재집계
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const uid of ids) {
    const prev = before.get(uid);
    try {
      if (DRY_RUN) {
        // dry-run: 공식만 재현 (write 없음)
        const { data } = await sb
          .from("user_week_statuses")
          .select("status, week_start_date")
          .eq("user_id", uid);
        const { isTransitionWeekStart } = await import("../lib/seasonCalendar");
        const rows = ((data ?? []) as any[]).filter(
          (r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date)),
        );
        const next = {
          approved_weeks: rows.filter((r) => r.status === "success").length,
          cumulative_weeks: rows.length,
        };
        const diff =
          prev?.approved !== next.approved_weeks || prev?.cumulative !== next.cumulative_weeks;
        if (diff) {
          changed++;
          console.log(
            `WOULD-FIX ${uid} approved ${prev?.approved ?? "∅"}→${next.approved_weeks}, cumulative ${prev?.cumulative ?? "∅"}→${next.cumulative_weeks}`,
          );
        } else unchanged++;
      } else {
        const next = await recalcUserGrowthStats(uid);
        const diff =
          prev?.approved !== next.approved_weeks || prev?.cumulative !== next.cumulative_weeks;
        if (diff) {
          changed++;
          console.log(
            `FIXED ${uid} approved ${prev?.approved ?? "∅"}→${next.approved_weeks}, cumulative ${prev?.cumulative ?? "∅"}→${next.cumulative_weeks}`,
          );
        } else unchanged++;
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${uid}`, e instanceof Error ? e.message : e);
    }
  }
  console.log(
    `\n완료: 변경 ${changed} / 동일 ${unchanged} / 실패 ${failed} (총 ${ids.size})`,
  );
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
