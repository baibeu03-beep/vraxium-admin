/**
 * 검수 완료 이중 재계산 제거 — 사이클 검증 전 READ-ONLY 프리체크.
 *   revert→finalize 사이클을 W1(운영)에 돌리기 전에, finalize 재확정이 막히지 않는지(게이트 green)
 *   + BEFORE 상태(주차 플래그·uws 분포·샘플 고객카드 resultStatus)를 확보한다. 쓰기 0.
 *
 *   npx tsx --env-file=.env.local scripts/verify-review-dedup-precheck.ts [weekId]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  assertWeekAccrualComplete,
  loadFinalizeCohort,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const DEFAULT_WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";

async function main() {
  const weekId = process.argv[2] || DEFAULT_WEEK;
  const { data: wk } = await supabaseAdmin.from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at")
    .eq("id", weekId).maybeSingle();
  const week = wk as any;
  console.log(`\n=== PRECHECK weekId=${weekId} (${week.start_date}) ===`);
  console.log(`published=${!!week.result_published_at} reviewed=${!!week.result_reviewed_at} officialRest=${week.is_official_rest}`);

  const fw: FinalizeWeekRow = {
    id: week.id, start_date: week.start_date, end_date: week.end_date,
    season_key: week.season_key, iso_year: week.iso_year, iso_week: week.iso_week,
    is_official_rest: week.is_official_rest,
  };

  // 1) 적립 게이트.
  const gate = await assertWeekAccrualComplete(fw);
  console.log(`\n[게이트] accrual ok=${gate.ok} reason=${gate.reason ?? "-"} awards=${gate.awardCount} pendingChk=${gate.pendingChecks} pendingIrr=${gate.pendingIrregular}`);

  // 2) 코호트 + verdict 분포(pending 있으면 finalize 차단).
  const cohort = await loadFinalizeCohort(week.season_key, "operating");
  const now = Date.now();
  const alwaysOpen = new Set<string>([weekId]);
  const dist: Record<string, number> = { success: 0, fail: 0, personal_rest: 0, pending: 0, not_applicable: 0, error: 0 };
  let cursor = 0;
  async function worker() {
    while (cursor < cohort.length) {
      const m = cohort[cursor++];
      if (m.seasonRest) { dist.personal_rest++; continue; }
      try {
        const vmap = await fetchExperienceRequiredSlotStatusByWeek(m.userId, [weekId], now, { alwaysOpenWeekIds: alwaysOpen, organizationSlug: m.org });
        const v = vmap.get(weekId);
        if (!v || v.status === "not_applicable") dist.not_applicable++;
        else if (v.status === "pending") dist.pending++;
        else if (v.status === "pass") dist.success++;
        else dist.fail++;
      } catch { dist.error++; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => worker()));
  console.log(`[코호트] ${cohort.length}명 · verdict 분포:`, dist);

  // 3) 실무 경험 라인 수(0이고 전원 fail 이면 mass-fail 가드로 차단).
  const { count: expLines } = await supabaseAdmin.from("cluster4_lines")
    .select("id", { count: "exact", head: true }).eq("week_id", weekId).eq("part_type", "experience");
  console.log(`[가드] experience 라인 수=${expLines}`);

  // 4) 현재 uws 상태 분포(BEFORE).
  const { data: uwsRows } = await supabaseAdmin.from("user_week_statuses")
    .select("user_id,status").eq("week_start_date", week.start_date);
  const uwsDist: Record<string, number> = {};
  for (const r of (uwsRows ?? []) as any[]) uwsDist[r.status] = (uwsDist[r.status] ?? 0) + 1;
  console.log(`[BEFORE uws] 총 ${(uwsRows ?? []).length}행 ·`, uwsDist);

  // 5) 샘플 고객카드 3명의 W1 카드 resultStatus(BEFORE).
  const sampleIds = cohort.slice(0, 3).map((m) => m.userId);
  console.log(`\n[BEFORE 고객카드 샘플] (${sampleIds.length}명, weekId=${weekId} 카드 resultStatus)`);
  for (const uid of sampleIds) {
    try {
      const cards = await getCluster4WeeklyCardsForProfileUser(uid);
      const c = cards.find((x: any) => x.weekId === weekId) as any;
      console.log(`  ${uid.slice(0, 8)} → resultStatus=${c?.resultStatus ?? "(카드없음)"} weekNo=${c?.weekNumber ?? "-"}`);
    } catch (e) { console.log(`  ${uid.slice(0, 8)} → 조회실패 ${e instanceof Error ? e.message : e}`); }
  }

  // 판정.
  const blocked = !gate.ok || dist.pending > 0 || ((expLines ?? 0) === 0 && dist.success === 0 && dist.fail > 0);
  console.log(`\n=== 사이클 안전 여부: ${blocked ? "❌ BLOCKED — revert 금지(재확정 막힘 위험)" : "✅ SAFE — revert→finalize 자기복원 가능"} ===`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
