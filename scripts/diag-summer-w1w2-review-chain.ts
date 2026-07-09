// READ-ONLY 진단: 여름 W1/W2 검수완료 체인 추적.
//   npx tsx --env-file=.env.local scripts/diag-summer-w1w2-review-chain.ts
import { createClient } from "@supabase/supabase-js";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ms(iso: string) {
  return Date.parse(`${iso}T00:00:00Z`);
}

async function main() {
  const todayIso = getCurrentActivityDateIso();
  const curStartMs = getCurrentWeekStartMs(todayIso);
  console.log("=== 기준 시각 ===");
  console.log("today(activity) =", todayIso);
  console.log("currentWeekStartMs =", curStartMs, curStartMs ? new Date(curStartMs).toISOString() : null);
  console.log("QA_HIDE_REAL_USERS =", QA_HIDE_REAL_USERS);
  console.log();

  // 1) 여름 주차들
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at,check_threshold")
    .eq("season_key", "2026-summer")
    .order("start_date", { ascending: true });
  if (wErr) throw wErr;
  console.log("=== 2026-summer weeks (operating) ===");
  for (const w of weeks ?? []) {
    const isCur = curStartMs != null && ms(w.start_date) === curStartMs;
    const isPast = curStartMs != null && ms(w.start_date) < curStartMs;
    console.log(
      `wnum=${w.week_number} iso=${w.iso_year}/${w.iso_week} ${w.start_date}~${w.end_date} ` +
      `${isCur ? "[CURRENT]" : isPast ? "[PAST]" : "[FUTURE]"} rest=${w.is_official_rest} ` +
      `pub=${w.result_published_at ? "Y" : "-"} rev=${w.result_reviewed_at ? "Y" : "-"} id=${w.id}`,
    );
  }
  console.log();

  const w1 = (weeks ?? []).find((w) => Number(w.week_number) === 1) ?? (weeks ?? [])[0];
  const w2 = (weeks ?? []).find((w) => Number(w.week_number) === 2) ?? (weeks ?? [])[1];
  const targetWeeks = [w1, w2].filter(Boolean);

  // 2) qa_weeks_state 오버레이
  console.log("=== qa_weeks_state overlay (해당 주차) ===");
  const { data: qa, error: qErr } = await sb
    .from("qa_weeks_state")
    .select("week_id,result_published_at,result_reviewed_at,check_threshold,updated_at")
    .in("week_id", targetWeeks.map((w) => w.id));
  if (qErr) console.log("  qa_weeks_state read error:", qErr.message);
  else if (!qa || qa.length === 0) console.log("  (행 없음 — qa 오버레이에 공표/검수 기록 없음)");
  else for (const r of qa) console.log("  ", JSON.stringify(r));
  console.log();

  // 3) cluster4_week_finalize_runs
  console.log("=== cluster4_week_finalize_runs (해당 주차) ===");
  const { data: runs, error: rErr } = await sb
    .from("cluster4_week_finalize_runs")
    .select("id,week_id,scope,cohort_count,success_count,fail_count,rest_count,skipped_count,created_uws_ids,updated_uws,reverted_at,created_at")
    .in("week_id", targetWeeks.map((w) => w.id))
    .order("created_at", { ascending: true });
  if (rErr) console.log("  finalize_runs read error:", rErr.message);
  else if (!runs || runs.length === 0) console.log("  (run 기록 없음 — finalizeWeekUws 가 uws 를 만든 적 없음/스킵)");
  else for (const r of runs) {
    const wnum = targetWeeks.find((w) => w.id === r.week_id)?.week_number;
    console.log(
      `  W${wnum} scope=${r.scope} cohort=${r.cohort_count} succ=${r.success_count} fail=${r.fail_count} rest=${r.rest_count} skip=${r.skipped_count} ` +
      `created=${(r.created_uws_ids ?? []).length} updated=${(r.updated_uws ?? []).length} reverted=${r.reverted_at ? "Y" : "-"} at=${r.created_at}`,
    );
  }
  console.log();

  // 4) user_week_statuses 카운트 (해당 주차 start_date 기준)
  console.log("=== user_week_statuses (week_start_date 기준 상태 분포) ===");
  const testIds = await fetchTestUserMarkerIds();
  for (const w of targetWeeks) {
    const { data: uws, error: uErr } = await sb
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", w.start_date);
    if (uErr) { console.log(`  W${w.week_number} uws read error:`, uErr.message); continue; }
    const dist: Record<string, number> = {};
    let testCount = 0;
    for (const r of uws ?? []) {
      dist[r.status] = (dist[r.status] ?? 0) + 1;
      if (testIds.has(r.user_id)) testCount++;
    }
    console.log(`  W${w.week_number} (${w.start_date}) total=${(uws ?? []).length} test유저분=${testCount} dist=${JSON.stringify(dist)}`);
  }
  console.log();

  // 5) 시즌 참여 test 유저 코호트(user_season_statuses) 및 그들의 W1/W2 uws 유무
  console.log("=== 2026-summer 참여 test 유저 × W1/W2 uws 매트릭스(샘플 15) ===");
  const { data: uss } = await sb
    .from("user_season_statuses")
    .select("user_id,status")
    .eq("season_key", "2026-summer");
  const seasonTestUsers = Array.from(
    new Set((uss ?? []).map((r) => r.user_id).filter((id) => testIds.has(id))),
  );
  console.log(`  시즌 참여 test 유저 수 = ${seasonTestUsers.length}`);

  // profiles (이름/org/growth)
  const profByUser = new Map<string, { name: string | null; org: string | null; growth: string | null }>();
  for (let i = 0; i < seasonTestUsers.length; i += 300) {
    const chunk = seasonTestUsers.slice(i, i + 300);
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug,growth_status")
      .in("user_id", chunk);
    for (const p of profs ?? []) profByUser.set(p.user_id, { name: p.display_name, org: p.organization_slug, growth: p.growth_status });
  }

  const uwsW1 = new Map<string, string>();
  const uwsW2 = new Map<string, string>();
  for (const [w, map] of [[w1, uwsW1], [w2, uwsW2]] as const) {
    for (let i = 0; i < seasonTestUsers.length; i += 300) {
      const chunk = seasonTestUsers.slice(i, i + 300);
      const { data } = await sb
        .from("user_week_statuses")
        .select("user_id,status")
        .eq("week_start_date", w.start_date)
        .in("user_id", chunk);
      for (const r of data ?? []) map.set(r.user_id, r.status);
    }
  }

  const sample = seasonTestUsers.slice(0, 15);
  for (const uid of sample) {
    const p = profByUser.get(uid);
    console.log(
      `  ${p?.name ?? "?"} [${p?.org ?? "?"}] growth=${p?.growth ?? "?"} | W1uws=${uwsW1.get(uid) ?? "(none)"} | W2uws=${uwsW2.get(uid) ?? "(none)"} | ${uid}`,
    );
  }
  console.log();

  // 6) 스냅샷: 샘플 유저의 저장 카드에서 W1/W2 존재/상태
  console.log("=== snapshot cards: 샘플 유저의 W1/W2 카드 상태 ===");
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,dto_version,is_stale,computed_at")
    .in("user_id", sample);
  const snapByUser = new Map((snaps ?? []).map((s) => [s.user_id, s]));
  for (const uid of sample) {
    const p = profByUser.get(uid);
    const s = snapByUser.get(uid);
    if (!s) { console.log(`  ${p?.name}: (snapshot 행 없음)`); continue; }
    const cards = Array.isArray(s.cards) ? s.cards : [];
    const findCard = (startDate: string) =>
      cards.find((c: any) => c.startDate === startDate || c.weekStartDate === startDate);
    const c1 = findCard(w1.start_date);
    const c2 = findCard(w2.start_date);
    console.log(
      `  ${p?.name}: v${s.dto_version}${s.dto_version !== undefined ? "" : ""} stale=${s.is_stale} computed=${s.computed_at} | ` +
      `W1card=${c1 ? (c1 as any).userWeekStatus ?? (c1 as any).status ?? "?" : "(없음)"} | ` +
      `W2card=${c2 ? (c2 as any).userWeekStatus ?? (c2 as any).status ?? "?" : "(없음)"}`,
    );
  }

  console.log("\n done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
