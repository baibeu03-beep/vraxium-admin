/**
 * READ-ONLY 진단: 실행 취소 후 /weekly-ranking 숫자가 남는 원인 조사.
 *   - weeks.result_published_at / result_reviewed_at (operating baseline)
 *   - qa_weeks_state overlay (있으면)
 *   - cluster4_week_finalize_runs 존재 + 이 주차 run 들의 reverted_at
 *   - user_week_statuses 현재 상태별 카운트(오늘 시점 live)
 *
 *   npx tsx --env-file=.env.local scripts/diag-weekly-ranking-revert-state.ts [weekId]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WEEK_ID = process.argv[2] ?? "496656d0-8d92-4738-b69b-e5e28aa1d57a";

async function main() {
  console.log("weekId:", WEEK_ID);

  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,week_number,result_published_at,result_reviewed_at,is_official_rest")
    .eq("id", WEEK_ID)
    .maybeSingle();
  console.log("\n=== weeks (operating baseline) ===");
  console.log(JSON.stringify(wk, null, 2));
  const startDate = (wk as { start_date?: string } | null)?.start_date ?? null;

  // qa_weeks_state overlay
  const { data: qa, error: qaErr } = await supabaseAdmin
    .from("qa_weeks_state")
    .select("*")
    .eq("week_id", WEEK_ID)
    .maybeSingle();
  console.log("\n=== qa_weeks_state overlay ===");
  if (qaErr) console.log("(read error / table missing):", qaErr.message);
  else console.log(JSON.stringify(qa, null, 2));

  // run-log table
  console.log("\n=== cluster4_week_finalize_runs (this week) ===");
  const { data: runs, error: runErr } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("id,scope,created_at,reverted_at,success_count,fail_count,rest_count,cohort_count,created_uws_ids,updated_uws")
    .eq("week_id", WEEK_ID)
    .order("created_at", { ascending: false });
  if (runErr) {
    console.log("!!! run-log 조회 실패 (마이그레이션 미적용 가능):", runErr.message);
  } else {
    console.log(`총 ${runs?.length ?? 0} run`);
    for (const r of (runs ?? []) as Array<Record<string, unknown>>) {
      console.log({
        id: r.id,
        scope: r.scope,
        created_at: r.created_at,
        reverted_at: r.reverted_at,
        success: r.success_count,
        fail: r.fail_count,
        rest: r.rest_count,
        created_uws: Array.isArray(r.created_uws_ids) ? (r.created_uws_ids as unknown[]).length : 0,
        updated_uws: Array.isArray(r.updated_uws) ? (r.updated_uws as unknown[]).length : 0,
      });
    }
  }

  // live uws counts for this week_start_date
  if (startDate) {
    console.log(`\n=== user_week_statuses live (week_start_date=${startDate}) ===`);
    for (const status of ["success", "fail", "personal_rest", "official_rest"]) {
      const { count } = await supabaseAdmin
        .from("user_week_statuses")
        .select("id", { count: "exact", head: true })
        .eq("week_start_date", startDate)
        .eq("status", status);
      console.log(`  ${status}: ${count ?? 0}`);
    }
    const { count: total } = await supabaseAdmin
      .from("user_week_statuses")
      .select("id", { count: "exact", head: true })
      .eq("week_start_date", startDate);
    console.log(`  TOTAL: ${total ?? 0}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
