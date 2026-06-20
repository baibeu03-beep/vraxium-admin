// 대량 배치(사용자 N명)에서 per-item 비동기 작업을 무제한 팬아웃(Promise.all(items.map(...)))
// 하면 N개의 Supabase 요청이 동시에 떠 connection pool / PostgREST 계층이 포화된다
// (522 Connection timed out · statement timeout). 동시 실행 개수를 고정 상한으로 묶어
// 풀 점유를 일정하게 유지한다. 결과는 입력 순서를 보존한다(Promise.all 과 동치).
//
// 사용:
//   const cards = await mapWithConcurrency(profiles, GROWTH_CARD_CONCURRENCY, async (p) => {
//     return getResolvedCardsForUser(p.user_id);
//   });
//
// 외부 의존성(p-limit 등) 없이 동작한다 — 워커 풀 패턴.

// 성장지표/카드 배치의 per-user snapshot 조회 동시 실행 상한.
// Supabase 풀(기본 ~15 직접연결 / PostgREST) 을 한 요청이 독점하지 않도록 8 로 고정한다.
// (요청 여러 개가 겹쳐도 8×요청수 로만 늘어 풀 포화 임계 아래를 유지.)
export const GROWTH_CARD_CONCURRENCY = 8;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const cappedLimit = Math.max(1, Math.min(limit, n));
  const results = new Array<R>(n);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= n) return;
      results[current] = await fn(items[current], current);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < cappedLimit; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
