import { createClient } from "@supabase/supabase-js";
import { tickQuery } from "@/lib/supabaseQueryMeter";
import { makeCohortAwareFetch } from "@/lib/cohortRequestCache";
import { makeTracingFetch } from "@/lib/perfTrace";

// fetch 래핑(안 → 밖): real fetch → tracing(net) → cohortAware → tracing(logical).
//   · cohortAware: 코호트 배치(runWithCohortRequestCache) 안에서만 동일 GET 을 요청 단위로 공유한다.
//     그 밖에서는 원본 fetch 그대로(no-op) — 기존 동작 불변. per-user snapshot 재계산이 전역/코호트-
//     불변 데이터를 유저마다 다시 조회하던 N+1 을 제거한다(조회 방식만 최적화·rows 동일).
//   · tracing: runWithPerfTrace 스코프 안에서만 동작하는 계측(그 밖에서는 통과·no-op).
//     logical 층 = supabase-js 가 발행한 쿼리 전부, net 층 = 실제 네트워크로 나간 쿼리.
//     두 층의 차이가 request cache 적중분이다. 계측은 요청/응답을 변형하지 않는다.
const cohortAwareFetch = makeCohortAwareFetch(
  makeTracingFetch(globalThis.fetch.bind(globalThis), "net"),
);
const instrumentedFetch = makeTracingFetch(cohortAwareFetch, "logical");

const rawSupabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { global: { fetch: instrumentedFetch } },
);

// .from() / .rpc() 호출마다 요청 단위 쿼리 카운터를 증가시킨다(계측용).
// 계측 컨텍스트(runWithQueryMeter) 밖에서는 tickQuery 가 no-op 이므로 동작 영향 없음.
export const supabaseAdmin: typeof rawSupabaseAdmin = new Proxy(
  rawSupabaseAdmin,
  {
    get(target, prop, receiver) {
      if (prop === "from" || prop === "rpc") {
        const fn = Reflect.get(target, prop, receiver) as (
          ...args: unknown[]
        ) => unknown;
        return (...args: unknown[]) => {
          tickQuery();
          return fn.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  },
);
