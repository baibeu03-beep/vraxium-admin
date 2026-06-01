// snapshot HIT 동작 검증(로컬, READ-ONLY):
//   - 저장된 snapshot 을 읽는 경로가 쿼리 1개로 끝나는지
//   - 그 과정에서 무거운 계산 함수(getWeeklyGrowth/computeWeeklyCards/fetchLineDetailsByWeek)
//     로그가 전혀 발생하지 않는지
// 를 라우트의 loadWeeklyCards(HIT 분기)와 동일한 호출(readWeeklyCardsSnapshot)로 측정한다.
//
//   npx tsx --env-file=.env.local scripts/verify-snapshot-hit.ts
import { createClient } from "@supabase/supabase-js";
import {
  currentQueryCount,
  runWithQueryMeter,
} from "@/lib/supabaseQueryMeter";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

// 무거운 계산 경로가 찍는 로그 시그니처(HIT 시 절대 나오면 안 됨).
const HEAVY_SIGNATURES = [
  "[weekly-cards][timing] getWeeklyGrowth",
  "line aggregates+verdict",
  "lineDetails+headerExtras",
];

async function main() {
  // 백필된 snapshot 중 fresh(is_stale=false) 1건 선택.
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count,is_stale")
    .eq("is_stale", false)
    .limit(1)
    .maybeSingle();
  const row = data as { user_id: string; card_count: number; is_stale: boolean } | null;
  if (!row) {
    console.log("검증할 fresh snapshot 없음 — 백필 먼저 실행하세요.");
    return;
  }
  console.log(`대상 user=${row.user_id} | card_count=${row.card_count} | is_stale=${row.is_stale}`);

  // console.log/ warn 가로채서 무거운 로그 발생 여부 감시.
  const captured: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => { captured.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { captured.push(a.join(" ")); };

  let queries = 0;
  let cardCount = 0;
  let status = "";
  const t0 = Date.now();
  await runWithQueryMeter("[verify]", async () => {
    const snap = await readWeeklyCardsSnapshot(row.user_id);
    queries = currentQueryCount();
    status = snap.status;
    cardCount = snap.status === "hit" || snap.status === "stale" ? snap.cards.length : -1;
  });
  const ms = Date.now() - t0;

  console.log = origLog;
  console.warn = origWarn;

  const heavyHits = captured.filter((line) =>
    HEAVY_SIGNATURES.some((sig) => line.includes(sig)),
  );

  console.log("\n========== SNAPSHOT HIT 검증 ==========");
  console.log(`반환 카드 수        : ${cardCount}`);
  console.log(`outcome             : ${status}  (기대 = hit)`);
  console.log(`supabaseQueries     : ${queries}  (HIT 기대값 = 1)`);
  console.log(`소요(읽기)          : ${ms}ms`);
  console.log(`무거운 계산 로그     : ${heavyHits.length === 0 ? "없음 ✅" : `발생 ❌ → ${heavyHits.join(" | ")}`}`);
  console.log("======================================");
  console.log(
    queries <= 1 && heavyHits.length === 0 && status === "hit"
      ? "RESULT: PASS — snapshot HIT 단일 쿼리, 무거운 계산 미발생."
      : "RESULT: CHECK — 기대와 다름(위 값 확인).",
  );
}
main().catch((e) => { console.error("fatal", e); process.exit(1); });
