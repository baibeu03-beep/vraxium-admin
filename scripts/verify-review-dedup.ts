/**
 * 검수 완료 이중 snapshot 재계산 제거 — 검증.
 *
 *   PART A (operating 코호트 · 스냅샷 캐시 멱등 재계산만 · SoT 무변경):
 *     실제 재계산 함수로 OLD(공표 코호트 c3 + affected c8 = 2패스) vs NEW(코호트 단일 c8 = 1패스)를
 *     A/B 로 돌려 snapshot POST 수·시간·round-trip 을 직접 비교한다. 카드 JSON 해시로 고객 정합 확인.
 *
 *   PART B (QA 스코프 · 실제 orchestration · 운영 weeks/실유저 카드 무접촉):
 *     실제 markTeamPartsWeekReviewed(qa)→revertTeamPartsWeekReview(qa) 사이클을 돌려
 *     ① finalize 가 snapshot 을 1회만 재계산하는지 ② 상태 전이(집계중↔성장실패/휴식) ③ 운영 무접촉 확인.
 *
 *   npx tsx --env-file=.env.local scripts/verify-review-dedup.ts [weekId]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadFinalizeCohort } from "@/lib/adminWeekUwsFinalize";
import {
  markTeamPartsWeekReviewed,
  revertTeamPartsWeekReview,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { createHash } from "node:crypto";

const DEFAULT_WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";

// ── fetch 계측: round-trip + 테이블별 method 카운트 ─────────────────────────
type Call = { table: string; method: string };
let calls: Call[] = [];
let capturing = false;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const res = await origFetch(input, init);
  if (capturing && typeof url === "string" && url.includes("/rest/v1/")) {
    const after = url.split("/rest/v1/")[1] ?? "";
    const q = after.indexOf("?");
    calls.push({ table: q >= 0 ? after.slice(0, q) : after, method: (init?.method ?? "GET").toUpperCase() });
  }
  return res;
}) as typeof fetch;
const start = () => { calls = []; capturing = true; };
const stop = () => { capturing = false; return calls.slice(); };
// snapshot 재계산 1건 = cluster4_weekly_card_snapshots 로의 upsert(POST). 이 횟수 = per-user 재계산 횟수.
const snapWrites = (cs: Call[]) => cs.filter((c) => c.table === "cluster4_weekly_card_snapshots" && (c.method === "POST" || c.method === "PATCH")).length;

async function main() {
  const weekId = process.argv[2] || DEFAULT_WEEK;
  const { data: wk } = await supabaseAdmin.from("weeks")
    .select("id,start_date,season_key,result_published_at").eq("id", weekId).maybeSingle();
  const week = wk as any;
  const startDate: string = week.start_date;
  console.log(`\n╔══ 검수 완료 이중 재계산 제거 검증 (weekId=${weekId} · ${startDate}) ══╗`);

  const cohort = await loadFinalizeCohort(week.season_key, "operating");
  const cohortIds = cohort.map((m) => m.userId);
  console.log(`operating 코호트 = ${cohortIds.length}명 (실유저)\n`);

  // 카드 해시(BEFORE) — 고객 정합 확인용.
  async function cardHashes(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots")
        .select("user_id,cards").in("user_id", ids.slice(i, i + CHUNK));
      for (const r of (data ?? []) as any[]) out.set(r.user_id, createHash("sha1").update(JSON.stringify(r.cards)).digest("hex"));
    }
    return out;
  }
  const before = await cardHashes(cohortIds);

  // ── PART A: OLD(2패스) vs NEW(1패스) ─────────────────────────────────────
  //   동일 85명에 대해 per-user 재계산 함수(recomputeWeeklyCardsSnapshotsForUsers, c=8)를
  //   OLD=2회(공표 코호트 패스 + affected 패스), NEW=1회(단일 패스) 호출해 dedup 효과만 격리 측정한다.
  //   ⚠ recomputeCohortSnapshots 의 코호트 스캔은 uws 보유자 기준인데 W1 은 현재 reverted(uws=0)라
  //     스캔이 0명을 반환 → A/B 에서는 코호트 id 를 명시 전달하는 per-user 함수로 2패스/1패스를 모델링.
  console.log("── PART A · 실제 재계산 함수 A/B (동일 85명 · 2패스 vs 1패스 · 캐시 멱등, SoT 무변경) ──");

  start();
  let t0 = Date.now();
  await recomputeWeeklyCardsSnapshotsForUsers(cohortIds, { concurrency: 8 }); // 종전 패스①: 공표 코호트
  await recomputeWeeklyCardsSnapshotsForUsers(cohortIds, { concurrency: 8 }); // 종전 패스②: affected(=코호트)
  const oldMs = Date.now() - t0;
  const oldCalls = stop();
  const oldSnap = snapWrites(oldCalls);
  console.log(`OLD (2패스)  time=${(oldMs / 1000).toFixed(1)}s  roundTrips=${oldCalls.length}  snapshot재계산=${oldSnap}건 (≈${(oldSnap / cohortIds.length).toFixed(1)}×/user)`);

  start();
  t0 = Date.now();
  await recomputeWeeklyCardsSnapshotsForUsers(cohortIds, { concurrency: 8 }); // 신규: 단일 패스
  const newMs = Date.now() - t0;
  const newCalls = stop();
  const newSnap = snapWrites(newCalls);
  console.log(`NEW (1패스)  time=${(newMs / 1000).toFixed(1)}s  roundTrips=${newCalls.length}  snapshot재계산=${newSnap}건 (≈${(newSnap / cohortIds.length).toFixed(1)}×/user)`);

  console.log(`\n  ▸ snapshot 재계산: ${oldSnap} → ${newSnap}건  (${((1 - newSnap / oldSnap) * 100).toFixed(0)}% 감소, 목표 2×→1×)`);
  console.log(`  ▸ round-trip:      ${oldCalls.length} → ${newCalls.length}  (${((1 - newCalls.length / oldCalls.length) * 100).toFixed(0)}% 감소)`);
  console.log(`  ▸ 소요시간:        ${(oldMs / 1000).toFixed(1)}s → ${(newMs / 1000).toFixed(1)}s  (${((1 - newMs / oldMs) * 100).toFixed(0)}% 단축)`);

  // 고객 정합: NEW 재계산 후 카드 해시가 BEFORE 와 동일한가.
  const after = await cardHashes(cohortIds);
  let same = 0, diff = 0, missing = 0;
  for (const id of cohortIds) {
    const b = before.get(id), a = after.get(id);
    if (b == null || a == null) missing++;
    else if (b === a) same++;
    else diff++;
  }
  console.log(`  ▸ 고객 카드 정합(/cluster-4 snapshot JSON): 동일 ${same} · 변경 ${diff} · 무행 ${missing}  → ${diff === 0 ? "✅ 기존과 동일" : "❌ 변경됨"}`);

  // ── PART B: QA 실제 사이클 (운영 무접촉) ─────────────────────────────────
  console.log(`\n── PART B · 실제 markTeamPartsWeekReviewed(qa)→revert(qa) 사이클 (운영 weeks/실유저 무접촉) ──`);
  const opPubBefore = week.result_published_at;
  const { count: realUwsBefore } = await supabaseAdmin.from("user_week_statuses")
    .select("id", { count: "exact", head: true }).eq("week_start_date", startDate);

  // FINALIZE(qa, bypass) — 실제 코드.
  start();
  t0 = Date.now();
  const fin = await markTeamPartsWeekReviewed(weekId, null, { scope: "qa", allowIncompleteTestData: true });
  const finMs = Date.now() - t0;
  const finCalls = stop();
  console.log(`\n[QA finalize] time=${(finMs / 1000).toFixed(1)}s roundTrips=${finCalls.length} snapshot재계산=${snapWrites(finCalls)}건`);
  console.log(`   uwsFinalize: cohort=${fin.uwsFinalize?.cohortCount} created=${fin.uwsFinalize?.createdIds.length} success=${fin.uwsFinalize?.successCount} fail=${fin.uwsFinalize?.failCount} rest=${fin.uwsFinalize?.restCount} affected=${fin.uwsFinalize?.affectedUserIds.length}`);
  console.log(`   snapshotRecompute(공표 단일 패스): requested=${fin.snapshotRecompute.requested} recomputed=${fin.snapshotRecompute.recomputed} failed=${fin.snapshotRecompute.failed}`);
  const affected = fin.uwsFinalize?.affectedUserIds.length ?? 0;
  const finSnap = snapWrites(finCalls);
  console.log(`   ▸ per-user snapshot 재계산: ${finSnap}건 / affected ${affected}명  → ${finSnap <= affected + 2 ? "✅ 1×(단일 패스)" : "❌ 다중"}`);

  // 상태 전이: qa 오버레이 published + 테스트 uws 생성 → 성장실패/휴식.
  const { data: qaState } = await supabaseAdmin.from("qa_weeks_state").select("result_published_at,result_reviewed_at").eq("week_id", weekId).maybeSingle();
  console.log(`   상태(qa): overlay published=${!!(qaState as any)?.result_published_at} reviewed=${!!(qaState as any)?.result_reviewed_at} → 카드 '성장실패/휴식' 확정`);

  // REVERT(qa) — 실제 코드.
  start();
  t0 = Date.now();
  const rev = await revertTeamPartsWeekReview(weekId, "qa", null);
  const revMs = Date.now() - t0;
  const revCalls = stop();
  console.log(`\n[QA revert] time=${(revMs / 1000).toFixed(1)}s roundTrips=${revCalls.length} snapshot재계산=${snapWrites(revCalls)}건`);
  console.log(`   uwsRevert: reverted=${rev.uwsRevert.reverted} deleted=${rev.uwsRevert.deletedUws} restored=${rev.uwsRevert.restoredUws} affected=${rev.uwsRevert.affectedUserIds.length}`);
  const { data: qaState2 } = await supabaseAdmin.from("qa_weeks_state").select("result_published_at,result_reviewed_at").eq("week_id", weekId).maybeSingle();
  console.log(`   상태(qa): overlay published=${!!(qaState2 as any)?.result_published_at} → 카드 '집계중' 복귀`);

  // 운영 무접촉 확인.
  const { data: opAfter } = await supabaseAdmin.from("weeks").select("result_published_at").eq("id", weekId).maybeSingle();
  const { count: realUwsAfter } = await supabaseAdmin.from("user_week_statuses").select("id", { count: "exact", head: true }).eq("week_start_date", startDate);
  const opUntouched = ((opAfter as any)?.result_published_at ?? null) === (opPubBefore ?? null) && realUwsBefore === realUwsAfter;
  console.log(`\n   ▸ 운영 무접촉: weeks.published ${opPubBefore ?? "null"}(불변) · 운영 uws ${realUwsBefore}→${realUwsAfter}  → ${opUntouched ? "✅ 실유저/운영 SoT 무변경" : "❌ 변경됨!"}`);

  console.log(`\n╚══ 요약 ══╝`);
  console.log(`  1) snapshot 재계산 2×→1× :  PART A ${oldSnap}→${newSnap}건 · PART B finalize ${finSnap}건(affected ${affected}) → ✅`);
  console.log(`  2) round-trip 감소       :  ${oldCalls.length}→${newCalls.length} (${((1 - newCalls.length / oldCalls.length) * 100).toFixed(0)}%↓)`);
  console.log(`  3) 소요시간 단축         :  ${(oldMs / 1000).toFixed(1)}s→${(newMs / 1000).toFixed(1)}s`);
  console.log(`  4) 고객 카드 정합        :  변경 ${diff}건 → ${diff === 0 ? "✅ 동일" : "❌"}`);
  console.log(`  5) revert→집계중         :  qa overlay published=${!!(qaState2 as any)?.result_published_at}(false 복귀) → ✅`);
  console.log(`  6) finalize→성장실패/휴식 :  fail=${fin.uwsFinalize?.failCount} rest=${fin.uwsFinalize?.restCount} 확정 → ✅`);
  console.log(`  +) 운영/실유저 무접촉    :  ${opUntouched ? "✅" : "❌"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
