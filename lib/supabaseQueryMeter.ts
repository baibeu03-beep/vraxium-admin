import { AsyncLocalStorage } from "node:async_hooks";

// 요청 단위 Supabase 쿼리 카운터.
// Fluid Compute 는 한 인스턴스가 동시 요청을 재사용하므로 module-level 전역 카운터는
// 요청 간 간섭이 생긴다. AsyncLocalStorage 로 요청별 격리한다.
//
// 사용:
//   return runWithQueryMeter("[weekly-cards]", async (meter) => {
//     ...handler...
//     console.log("queries =", meter.count);
//   });
// supabaseAdmin.from(...) 호출마다 tickQuery() 가 자동 증가시킨다(supabaseAdmin Proxy).

export type QueryMeter = { count: number; timeouts: number; label: string };

const als = new AsyncLocalStorage<QueryMeter>();

export function runWithQueryMeter<T>(
  label: string,
  fn: (meter: QueryMeter) => Promise<T>,
): Promise<T> {
  const meter: QueryMeter = { count: 0, timeouts: 0, label };
  return als.run(meter, () => fn(meter));
}

// supabaseAdmin Proxy 가 매 .from() 호출 시 부른다. 메터가 없으면(계측 밖) no-op.
export function tickQuery(): void {
  const meter = als.getStore();
  if (meter) meter.count += 1;
}

// Supabase 조회가 timeout/connection 오류(522 · statement timeout)로 실패할 때마다 부른다.
// 대량 조회 포화 모니터링용 — 메터가 없으면(계측 밖) no-op.
export function tickTimeout(): void {
  const meter = als.getStore();
  if (meter) meter.timeouts += 1;
}

export function currentQueryCount(): number {
  return als.getStore()?.count ?? 0;
}
