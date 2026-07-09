import { createClient } from "@supabase/supabase-js";
import { tickQuery } from "@/lib/supabaseQueryMeter";
import { makeCohortAwareFetch } from "@/lib/cohortRequestCache";

// fetch 래핑: 코호트 배치(runWithCohortRequestCache) 안에서만 동일 GET 을 요청 단위로 공유한다.
//   그 밖에서는 원본 fetch 그대로(no-op) — 기존 동작 불변. per-user snapshot 재계산이 전역/코호트-
//   불변 데이터를 유저마다 다시 조회하던 N+1 을 제거한다(조회 방식만 최적화·rows 동일).
const cohortAwareFetch = makeCohortAwareFetch(
  globalThis.fetch.bind(globalThis),
);

const rawSupabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { global: { fetch: cohortAwareFetch } },
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
