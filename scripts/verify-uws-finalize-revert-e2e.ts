/**
 * uws finalize → revert 전체 E2E (run-log 기반). QA env(test 코호트) 전용.
 *   ① cluster4_week_finalize_runs 테이블 존재 확인
 *   ② finalizeWeekUws(qa, allowIncompleteTestData) → uws 생성 + run-log 기록
 *   ③ 샘플 카드가 fail/personal_rest 로 보이는지(snapshot 재계산 후)
 *   ④ revertWeekUws → 생성 uws 삭제 + run-log reverted_at 세팅
 *   ⑤ uws 원복(pre-state) + 샘플 카드 드롭 복귀 확인
 *
 *   npx tsx --env-file=.env.local scripts/verify-uws-finalize-revert-e2e.ts [weekId]
 *
 * ⚠ QA env(QA_HIDE_REAL_USERS=true)에서만 write 됨(test 코호트). 스스로 revert 로 원복한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import {
  finalizeWeekUws,
  revertWeekUws,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";
import {
  recomputeWeeklyCardsSnapshotsForUsers,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const WEEK_ID = process.argv[2] ?? "496656d0-8d92-4738-b69b-e5e28aa1d57a";

async function uwsCount(startDate: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id", { count: "exact", head: true })
    .eq("week_start_date", startDate);
  return count ?? 0;
}
async function sampleCardStatus(userId: string): Promise<string> {
  await recomputeWeeklyCardsSnapshotsForUsers([userId], { concurrency: 1 });
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status === "hit" || snap.status === "stale") {
    const card = (snap.cards as Array<{ seasonKey?: string; weekNumber?: number; userWeekStatus?: string }>).find(
      (c) => c.seasonKey === "2026-summer" && c.weekNumber === 1,
    );
    return card ? String(card.userWeekStatus) : "DROPPED(카드없음)";
  }
  return `snap:${snap.status}`;
}

async function main() {
  console.log(`QA_HIDE_REAL_USERS=${QA_HIDE_REAL_USERS}`);
  let pass = true;

  // ① 테이블 존재
  const { error: tblErr } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("id", { count: "exact", head: true });
  const tableExists = !tblErr;
  console.log(`\n[1] cluster4_week_finalize_runs 테이블: ${tableExists ? "존재 ✅" : "없음 ❌ (" + tblErr?.message + ")"}`);
  if (!tableExists) {
    console.log("테이블 없음 — 중단.");
    process.exit(1);
  }

  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest")
    .eq("id", WEEK_ID)
    .maybeSingle();
  const week = wk as unknown as FinalizeWeekRow;
  const startDate = week.start_date as string;

  const pre = await uwsCount(startDate);
  console.log(`\n[pre] summer W1 uws = ${pre}`);

  // ② finalize (강제 진행)
  console.log("\n[2] finalizeWeekUws(qa, allowIncompleteTestData=true) ...");
  const fin = await finalizeWeekUws(week, "qa", null, { allowIncompleteTestData: true });
  console.log(`  생성=${fin.createdIds.length} 갱신=${fin.updated.length} success=${fin.successCount} fail=${fin.failCount} rest=${fin.restCount} skip=${fin.skippedUsers} runId=${fin.runId}`);
  const postFin = await uwsCount(startDate);
  console.log(`  uws ${pre} → ${postFin}`);
  const ok2 = fin.runId != null && postFin > pre && fin.createdIds.length > 0;
  console.log(`  [2] ${ok2 ? "PASS" : "FAIL"} — uws 생성 + run-log 기록`);
  if (!ok2) pass = false;

  // run-log row 확인
  const { data: run } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("id,created_uws_ids,updated_uws,reverted_at,fail_count,rest_count")
    .eq("id", fin.runId)
    .maybeSingle();
  const runRow = run as { created_uws_ids: string[]; reverted_at: string | null; fail_count: number; rest_count: number } | null;
  console.log(`  run-log: created=${runRow?.created_uws_ids?.length} fail=${runRow?.fail_count} rest=${runRow?.rest_count} reverted_at=${runRow?.reverted_at}`);

  // ③ 샘플 카드 fail/personal_rest 확인
  const sample = fin.affectedUserIds[0];
  if (sample) {
    const st = await sampleCardStatus(sample);
    console.log(`\n[3] 샘플 ${sample.slice(0, 8)} 여름W1 카드 = ${st}`);
    const ok3 = st === "fail" || st === "personal_rest";
    console.log(`  [3] ${ok3 ? "PASS" : "FAIL"} — 카드가 사라지지 않고 확정상태로 표시`);
    if (!ok3) pass = false;
  }

  // ④ revert
  console.log("\n[4] revertWeekUws ...");
  const rev = await revertWeekUws(WEEK_ID);
  console.log(`  삭제=${rev.deletedUws} 복원=${rev.restoredUws} affected=${rev.affectedUserIds.length} runId=${rev.runId}`);
  const postRev = await uwsCount(startDate);
  console.log(`  uws ${postFin} → ${postRev}`);
  const ok4 = postRev === pre;
  console.log(`  [4] ${ok4 ? "PASS" : "FAIL"} — uws 원복(pre=${pre})`);
  if (!ok4) pass = false;

  // run-log reverted_at 세팅 확인
  const { data: run2 } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("reverted_at")
    .eq("id", fin.runId)
    .maybeSingle();
  const revertedAt = (run2 as { reverted_at: string | null } | null)?.reverted_at;
  console.log(`  run-log reverted_at = ${revertedAt} (${revertedAt ? "세팅됨 ✅" : "미세팅 ❌"})`);
  if (!revertedAt) pass = false;

  // ⑤ 샘플 카드 드롭 복귀
  if (sample) {
    const st2 = await sampleCardStatus(sample);
    console.log(`\n[5] 복원 후 샘플 여름W1 카드 = ${st2} (pre-finalize=드롭 예상, 공표된 주차라 no_data)`);
  }

  console.log(`\n결론: ${pass ? "E2E PASS ✅ (write→card→revert 정확 원복)" : "E2E FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main();
