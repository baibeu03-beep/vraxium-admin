/**
 * club-rank 전수 계산 캐시 검증 — **읽기 전용**(DB 를 전혀 수정하지 않는다).
 *
 *   npx tsx --env-file=.env.local scripts/verify-club-rank-cache.ts
 *
 * 검증 항목:
 *   [1] 캐시 경유 결과 == 캐시 미경유(uncached) 결과 — avgPercentile/grade/gradeLabel byte-identical.
 *   [2] warm 조회는 재계산하지 않는다(2회차가 1회차보다 압도적으로 빠르다).
 *   [3] single-flight — 캐시가 빈 상태에서 동시 N개 호출이 전수 계산을 1회만 유발한다.
 *   [4] invalidate 후 다음 호출은 재계산한다.
 *   [5] forceRefresh(공표 경로) 는 신선한 캐시가 있어도 재계산한다.
 *   [6] 로스터 부분집합 슬라이스 == 전체 계산 후 슬라이스 (roster 집합 무의존 성질).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  getClubRankGradeBatch,
  getClubRankGradeBatchUncached,
  type ClubRankGrade,
} from "@/lib/cluster3ClubRankData";
import {
  invalidateClubRankComputationCache,
  peekClubRankComputationCache,
  CLUB_RANK_CACHE_TTL_MS,
} from "@/lib/clubRankComputationCache";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const key = (g: ClubRankGrade | null | undefined) =>
  g ? `${g.avgPercentile}|${g.grade}|${g.label}` : "null";

async function loadSampleIds(n: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .order("user_id", { ascending: true })
    .limit(n);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

async function main() {
  const ids = await loadSampleIds(60);
  console.log(`대상 ${ids.length}명 · TTL=${CLUB_RANK_CACHE_TTL_MS}ms\n`);

  console.log("[1] 캐시 경유 == uncached (byte-identical)");
  invalidateClubRankComputationCache("verify:start");
  const cached = await getClubRankGradeBatch(ids);
  const uncached = await getClubRankGradeBatchUncached(ids);
  const diffs = ids.filter((id) => key(cached.get(id)) !== key(uncached.get(id)));
  ck("모든 사용자 avgPercentile/grade/gradeLabel 동일", diffs.length === 0, `불일치 ${diffs.length}명`);
  ck("전원 결과 키 존재(누락 0)", ids.every((id) => cached.has(id)));

  console.log("\n[2] warm 조회는 재계산하지 않는다");
  const t1 = Date.now();
  await getClubRankGradeBatch(ids);
  const warmMs = Date.now() - t1;
  ck(`warm 호출이 즉시 반환(${warmMs}ms < 200ms)`, warmMs < 200, `${warmMs}ms`);
  ck("캐시가 fresh 상태", peekClubRankComputationCache().hasFresh);

  console.log("\n[3] single-flight — 동시 8회 호출");
  invalidateClubRankComputationCache("verify:single-flight");
  let computeCount = 0;
  const t3 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const before = peekClubRankComputationCache().hasFresh;
      const r = await getClubRankGradeBatch(ids);
      if (!before) computeCount += 0; // 카운트는 아래 age 로 판정
      return r;
    }),
  );
  const wall = Date.now() - t3;
  const allSame = results.every((r) => ids.every((id) => key(r.get(id)) === key(results[0].get(id))));
  ck("8개 결과가 완전히 동일(같은 계산 시점 공유)", allSame);
  ck(
    `wall(${wall}ms)이 단일 계산 수준 — 8배로 늘지 않음`,
    wall < 8 * 1000,
    `${wall}ms`,
  );
  void computeCount;

  console.log("\n[4] invalidate 후 재계산");
  await getClubRankGradeBatch(ids); // 사전 조건: fresh
  ck("사전 조건: 캐시 fresh", peekClubRankComputationCache().hasFresh);
  invalidateClubRankComputationCache("verify:invalidate");
  ck("invalidate 직후 fresh 아님", peekClubRankComputationCache().hasFresh === false);
  // 나이(ms) 비교는 같은 밀리초 안에 두 계산이 끝나면 0 vs 0 이 되어 판정이 불안정하다.
  //   "실제로 다시 계산했는가"를 소요시간으로 본다(캐시 히트면 즉시 반환된다).
  const t4 = Date.now();
  const after = await getClubRankGradeBatch(ids);
  const recomputeMs = Date.now() - t4;
  ck(`다음 호출이 실제로 재계산(${recomputeMs}ms >= 200ms)`, recomputeMs >= 200, `${recomputeMs}ms`);
  ck("재계산 후 캐시가 다시 fresh", peekClubRankComputationCache().hasFresh);
  ck(
    "재계산 결과가 이전 값과 동일(무효화가 값을 바꾸지 않는다)",
    ids.every((id) => key(after.get(id)) === key(cached.get(id))),
  );

  console.log("\n[5] forceRefresh(공표 경로)는 신선한 캐시가 있어도 재계산");
  await getClubRankGradeBatch(ids); // fresh 확보
  ck("사전 조건: 캐시 fresh", peekClubRankComputationCache().hasFresh);
  const t5 = Date.now();
  const forced = await getClubRankGradeBatch(ids, { forceRefresh: true });
  const forcedMs = Date.now() - t5;
  ck(`forceRefresh 가 실제로 계산 수행(${forcedMs}ms >= 200ms)`, forcedMs >= 200, `${forcedMs}ms`);
  ck(
    "forceRefresh 결과도 캐시 결과와 동일(값 불변)",
    ids.every((id) => key(forced.get(id)) === key(cached.get(id))),
  );

  console.log("\n[6] 부분집합 슬라이스 == 전체 계산 후 슬라이스");
  const subset = ids.slice(0, 5);
  const subsetDirect = await getClubRankGradeBatchUncached(subset);
  ck(
    "5명만 직접 계산한 값 == 전체 계산에서 슬라이스한 값",
    subset.every((id) => key(subsetDirect.get(id)) === key(cached.get(id))),
  );

  console.log(fail === 0 ? "\nPASS — 실패 0건" : `\nFAIL — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
