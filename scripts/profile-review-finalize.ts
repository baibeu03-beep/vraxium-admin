/**
 * 검수 완료(markTeamPartsWeekReviewed) 단계별 실측 프로파일러 — READ + 멱등 재계산만.
 *
 *   실제 orchestration 의 각 하위 함수를 그대로 호출하되 SoT(uws status·weeks 플래그)는
 *   건드리지 않는다. 무거운 재계산(snapshot·growth)은 SoT 에서 재도출해 동일값을 캐시에
 *   다시 쓰는 멱등 연산이라 실제 흐름과 동일 비용이면서 안전하다.
 *
 *   계측:
 *     - 각 단계 wall-clock (ms)
 *     - global.fetch 를 감싸 실제 HTTP round-trip 수 · 테이블별 분포 · 느린 쿼리 · 중복 SELECT
 *     - per-user snapshot 재계산 시간 분포(내장 [weekly-cards][timing] 로그도 함께 출력)
 *
 *   npx tsx --env-file=.env.local scripts/profile-review-finalize.ts [weekId]
 *   기본 weekId = 2026-summer W1 (496656d0-…, 코호트 85명).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import {
  assertWeekAccrualComplete,
  loadFinalizeCohort,
  type FinalizeWeekRow,
} from "@/lib/adminWeekUwsFinalize";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";

const DEFAULT_WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";

// ── global.fetch 계측 래퍼 (Supabase REST round-trip 지상 진실) ──────────────
type Call = { table: string; method: string; qs: string; ms: number };
let calls: Call[] = [];
let capturing = false;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const started = Date.now();
  const res = await origFetch(input, init);
  if (capturing && typeof url === "string" && url.includes("/rest/v1/")) {
    const after = url.split("/rest/v1/")[1] ?? "";
    const qmark = after.indexOf("?");
    const table = qmark >= 0 ? after.slice(0, qmark) : after;
    const qs = qmark >= 0 ? after.slice(qmark + 1) : "";
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ table, method, qs, ms: Date.now() - started });
  }
  return res;
}) as typeof fetch;

function startCapture() { calls = []; capturing = true; }
function stopCapture(): Call[] { capturing = false; return calls; }

// 단계 측정 헬퍼: wall-clock + .from() 카운트 + fetch round-trip 캡처.
type StageResult<T> = { label: string; ms: number; fromCount: number; roundTrips: number; calls: Call[]; value: T };
const stages: Omit<StageResult<unknown>, "value">[] = [];
async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  startCapture();
  const t0 = Date.now();
  const value = await runWithQueryMeter(label, async (meter) => {
    const v = await fn();
    return { v, count: meter.count };
  });
  const ms = Date.now() - t0;
  const c = stopCapture();
  stages.push({ label, ms, fromCount: value.count, roundTrips: c.length, calls: c.slice() });
  console.log(`  ▶ ${label.padEnd(42)} ${String(ms).padStart(7)} ms | from()=${value.count} | roundTrips=${c.length}`);
  return value.v;
}

// 제한 동시성 워커 풀(원본 recompute 함수와 동일 패턴).
async function pool<T>(items: T[], concurrency: number, work: (item: T, idx: number) => Promise<void>) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try { await work(items[idx], idx); } catch { /* isolate */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  const weekId = process.argv[2] || DEFAULT_WEEK;
  console.log(`\n=== 검수 완료 단계별 실측 프로파일 (weekId=${weekId}) ===`);
  console.log(`REVIEW_RECOMPUTE_CONCURRENCY=8 · publish recompute concurrency=3 · verdict concurrency=6\n`);

  // ── Stage 0: 주차 메타 조회 ────────────────────────────────────────────────
  const week = await stage("0. weeks 메타 조회", async () => {
    const { data } = await supabaseAdmin.from("weeks")
      .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at")
      .eq("id", weekId).maybeSingle();
    return data as any;
  });
  if (!week) { console.error("주차 없음"); return; }
  const finalizeWeek: FinalizeWeekRow = {
    id: week.id, start_date: week.start_date, end_date: week.end_date,
    season_key: week.season_key, iso_year: week.iso_year, iso_week: week.iso_week,
    is_official_rest: week.is_official_rest,
  };

  // ── Stage 0.5a: 적립 완료 게이트 ───────────────────────────────────────────
  await stage("0.5a assertWeekAccrualComplete", () => assertWeekAccrualComplete(finalizeWeek));

  // ── Stage 0.5b: 코호트 로드 ────────────────────────────────────────────────
  const cohort = await stage("0.5b loadFinalizeCohort", () => loadFinalizeCohort(week.season_key, "operating"));
  console.log(`     → 코호트 ${cohort.length}명`);

  // ── Stage 0.5c: computeUserVerdicts (concurrency 6, per-user 엔진) ─────────
  const now = Date.now();
  const alwaysOpen = new Set<string>([weekId]);
  const verdictTimes: number[] = [];
  await stage("0.5d computeUserVerdicts (c=6)", async () => {
    await pool(cohort, 6, async (m) => {
      const t = Date.now();
      await fetchExperienceRequiredSlotStatusByWeek(m.userId, [weekId], now, {
        alwaysOpenWeekIds: alwaysOpen, organizationSlug: m.org,
      });
      verdictTimes.push(Date.now() - t);
    });
  });
  const vs = [...verdictTimes].sort((a, b) => a - b);
  console.log(`     → per-user verdict: p50=${pctl(vs,50)}ms p90=${pctl(vs,90)}ms max=${vs[vs.length-1]}ms sum=${vs.reduce((a,b)=>a+b,0)}ms`);

  // ── Stage 0.5e: 기존 uws 조회 ──────────────────────────────────────────────
  const cohortIds = cohort.map((m) => m.userId);
  await stage("0.5e 기존 uws 조회(.in chunk)", async () => {
    const CHUNK = 300;
    for (let i = 0; i < cohortIds.length; i += CHUNK) {
      await supabaseAdmin.from("user_week_statuses")
        .select("id,user_id,status").eq("week_start_date", week.start_date)
        .in("user_id", cohortIds.slice(i, i + CHUNK));
    }
  });

  // ── Stage 1: publishWeekResult → recomputeCohortSnapshots (전 코호트, c=3) ─
  //   실제 첫 공표 경로의 지배적 비용. 멱등 재계산(SoT→캐시 동일값).
  const snapTimes: number[] = [];
  await stage("1. cohort snapshot 재계산 (c=3, 전원)", async () => {
    await pool(cohortIds, 3, async (uid) => {
      const t = Date.now();
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      snapTimes.push(Date.now() - t);
    });
  });
  const ss = [...snapTimes].sort((a, b) => a - b);
  console.log(`     → per-user snapshot: p50=${pctl(ss,50)}ms p90=${pctl(ss,90)}ms max=${ss[ss.length-1]}ms sum(직렬환산)=${ss.reduce((a,b)=>a+b,0)}ms`);

  // ── Stage 1.5a: affected snapshot 재계산 (c=8) — 신규 확정 시 affected≈코호트 ─
  const snap2Times: number[] = [];
  await stage("1.5a affected snapshot 재계산 (c=8)", async () => {
    await pool(cohortIds, 8, async (uid) => {
      const t = Date.now();
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      snap2Times.push(Date.now() - t);
    });
  });
  const ss2 = [...snap2Times].sort((a, b) => a - b);
  console.log(`     → per-user snapshot(c=8): p50=${pctl(ss2,50)}ms p90=${pctl(ss2,90)}ms max=${ss2[ss2.length-1]}ms`);

  // ── Stage 1.5b: growth 캐시 재계산 (c=8) ──────────────────────────────────
  const growthTimes: number[] = [];
  await stage("1.5b user_growth_stats 재계산 (c=8)", async () => {
    await pool(cohortIds, 8, async (uid) => {
      const t = Date.now();
      await recalcUserGrowthStats(uid);
      growthTimes.push(Date.now() - t);
    });
  });
  const gs = [...growthTimes].sort((a, b) => a - b);
  console.log(`     → per-user growth: p50=${pctl(gs,50)}ms p90=${pctl(gs,90)}ms max=${gs[gs.length-1]}ms`);

  // ── Stage 2: 검수 완료 write (SELECT 비용만 측정 — 실제 UPDATE 미실행) ──────
  await stage("2. markWeekResultReviewed(SELECT만)", async () => {
    await supabaseAdmin.from("weeks")
      .select("id,result_published_at,result_reviewed_at").eq("id", weekId).maybeSingle();
  });

  // ── 집계 리포트 ───────────────────────────────────────────────────────────
  const total = stages.reduce((a, s) => a + s.ms, 0);
  const totalRT = stages.reduce((a, s) => a + s.roundTrips, 0);
  console.log(`\n검수 완료 시작`);
  console.log("-".repeat(72));
  for (const s of stages) {
    const pct = ((s.ms / total) * 100).toFixed(1);
    console.log(`${s.label.padEnd(42)} ${String(s.ms).padStart(8)} ms  (${pct.padStart(5)}%)  RT=${s.roundTrips}`);
  }
  console.log("-".repeat(72));
  console.log(`${"총".padEnd(42)} ${String(total).padStart(8)} ms          RT=${totalRT}`);

  // Top 5 느린 단계.
  console.log(`\n[1] 가장 오래 걸리는 Top 5 단계`);
  [...stages].sort((a, b) => b.ms - a.ms).slice(0, 5).forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.label.padEnd(40)} ${s.ms} ms (${((s.ms/total)*100).toFixed(1)}%)`));

  // 전체 fetch round-trip 을 테이블별 집계(모든 단계 합산).
  const allCalls = stages.flatMap((s) => s.calls);
  const byTable = new Map<string, { n: number; ms: number; method: Set<string> }>();
  for (const c of allCalls) {
    const k = c.table;
    const e = byTable.get(k) ?? { n: 0, ms: 0, method: new Set() };
    e.n++; e.ms += c.ms; e.method.add(c.method); byTable.set(k, e);
  }
  console.log(`\n[2/5] 테이블별 DB round-trip (총 ${allCalls.length}회, 누적시간 — 병렬이라 wall-clock<합)`);
  [...byTable.entries()].sort((a, b) => b[1].ms - a[1].ms).forEach(([t, e]) =>
    console.log(`  ${t.padEnd(42)} n=${String(e.n).padStart(4)} Σ${String(e.ms).padStart(6)}ms avg=${(e.ms/e.n).toFixed(0)}ms [${[...e.method].join(",")}]`));

  // 느린 개별 쿼리 Top 10.
  console.log(`\n[2] 가장 느린 개별 SQL round-trip Top 10`);
  [...allCalls].sort((a, b) => b.ms - a.ms).slice(0, 10).forEach((c, i) =>
    console.log(`  ${i + 1}. ${String(c.ms).padStart(6)}ms ${c.method} ${c.table}?${c.qs.slice(0, 90)}`));

  // 중복 SELECT 탐지(동일 method+table+qs 반복).
  const sig = new Map<string, number>();
  for (const c of allCalls) {
    if (c.method !== "GET") continue;
    const k = `${c.table}?${c.qs}`;
    sig.set(k, (sig.get(k) ?? 0) + 1);
  }
  const dups = [...sig.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  console.log(`\n[6] 동일 SELECT 반복(중복) — 상위 15`);
  if (dups.length === 0) console.log("  (완전 동일 querystring 반복 없음 — 단, user_id만 다른 동형 쿼리는 N+1 참조)");
  dups.slice(0, 15).forEach(([k, n]) => console.log(`  ${n}× ${k.slice(0, 100)}`));

  console.log(`\n[4] 처리 유저 수: 코호트 ${cohort.length}명`);
  console.log(`[5] 총 DB round-trip(계측 단계 합): ${totalRT}회  ≈ 유저당 ${(totalRT / Math.max(1,cohort.length)).toFixed(1)}회`);
  console.log(`[8] snapshot 처리 방식: 유저별 제한 동시성 워커풀(순차 아님) — publish=c3, affected=c8`);
  console.log(`\n(주의) Stage 1 과 1.5a 는 동일 유저 snapshot 을 두 번 재계산 — 실제 흐름의 잠재 중복.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
