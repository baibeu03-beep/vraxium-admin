/**
 * weekly-cards "재계산 경로"(snapshot miss/stale 시 진입) 실측 — 읽기 전용.
 *
 * 조회 경로(snapshot HIT)는 계산을 하지 않는다. 재계산은 miss/is_stale/주차경계 때만 일어나므로,
 * 그 경로의 실제 비용(쿼리 수·helper wall·반복 조회)을 따로 계측한다.
 *
 * ⚠ getCluster4WeeklyCardsForProfileUser 만 호출한다(순수 계산) — snapshot upsert 를 하지 않으므로
 *   어떤 데이터도 쓰지 않는다. recomputeAndStoreWeeklyCardsSnapshot(=계산+upsert)은 부르지 않는다.
 *
 * 사용: tsx --env-file=.env.local scripts/diag-weekly-cards-recompute-cost.ts [--user=<uuid>]
 */
import { createClient } from "@supabase/supabase-js";
import {
  runWithPerfTrace,
  formatTrace,
  concurrency,
  duplicateQueries,
  tableFanout,
} from "@/lib/perfTrace";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";

const arg = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? null;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  let userId = arg("user");
  if (!userId) {
    const { data } = await supabase
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,card_count")
      .order("computed_at", { ascending: false })
      .limit(1);
    userId = (data?.[0] as { user_id: string } | undefined)?.user_id ?? null;
  }
  if (!userId) throw new Error("대상 user 없음");

  // 전역 stale 현황 — 조회 경로에서 재계산이 얼마나 자주 일어나는지의 근거.
  const { count: total } = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true });
  const { count: stale } = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true })
    .eq("is_stale", true);

  console.log("═".repeat(78));
  console.log("weekly-cards 재계산 경로 비용 (읽기 전용 — snapshot 미변경)");
  console.log("═".repeat(78));
  console.log(`대상 user = ${userId}`);
  console.log(`snapshot 모집단: 총 ${total}행 · is_stale=true ${stale}행 (${((stale ?? 0) / (total || 1) * 100).toFixed(1)}%)`);
  console.log();

  const { trace } = await runWithPerfTrace("[recompute-path]", () =>
    runWithQueryMeter("[recompute]", async () => {
      const cards = await getCluster4WeeklyCardsForProfileUser(userId!);
      console.log(`(계산 결과 카드 ${cards.length}장 — 저장하지 않음)\n`);
      return cards;
    }),
  );

  console.log(formatTrace(trace));

  const c = concurrency(trace);
  const logical = trace.queries.filter((q) => q.layer === "logical");
  console.log(`\n${"═".repeat(78)}`);
  console.log("재계산 경로 요약");
  console.log("═".repeat(78));
  console.log(`  총 wall           : ${trace.totalMs.toFixed(0)}ms`);
  console.log(`  쿼리 수(logical)  : ${logical.length}`);
  console.log(`  DB 대기(union)    : ${c.unionMs.toFixed(0)}ms  (${((c.unionMs / trace.totalMs) * 100).toFixed(0)}% of wall)`);
  console.log(`  CPU/계산          : ${(trace.totalMs - c.unionMs).toFixed(0)}ms`);
  console.log(`  실효 병렬도       : ${c.factor.toFixed(2)}x (maxParallel=${c.maxParallel})`);
  console.log(`  완전 동일 쿼리 중복: ${duplicateQueries(trace).reduce((s, d) => s + d.count - 1, 0)}회 낭비`);
  console.log(`  테이블 반복 조회  : ${tableFanout(trace).filter((t) => t.count > 1).length}개 테이블`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
