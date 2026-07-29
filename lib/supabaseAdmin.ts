import { createClient } from "@supabase/supabase-js";
import { tickQuery } from "@/lib/supabaseQueryMeter";
import { makeCohortAwareFetch } from "@/lib/cohortRequestCache";
import { makeReferenceAwareFetch } from "@/lib/referenceReadCache";
import { makeTracingFetch } from "@/lib/perfTrace";

// fetch 래핑(안 → 밖): real fetch → tracing(net) → cohortAware → referenceAware → tracing(logical).
//   · cohortAware: 코호트 배치(runWithCohortRequestCache) 안에서만 동일 GET 을 요청 단위로 공유한다.
//     그 밖에서는 원본 fetch 그대로(no-op) — 기존 동작 불변. per-user snapshot 재계산이 전역/코호트-
//     불변 데이터를 유저마다 다시 조회하던 N+1 을 제거한다(조회 방식만 최적화·rows 동일).
//   · referenceAware: 쓰기 라우트(runWithReferenceReadCache) 안에서 **그 요청이 쓰지 않는 참조
//     테이블**(weeks·activity_types·user_profiles·test_user_markers 등)의 동일 GET 만 공유한다.
//     쓰기 대상 테이블은 화이트리스트에 없어 항상 실제 DB 를 읽는다(write-then-read 정합 보존).
//   · tracing: runWithPerfTrace 스코프 안에서만 동작하는 계측(그 밖에서는 통과·no-op).
//     logical 층 = supabase-js 가 발행한 쿼리 전부, net 층 = 실제 네트워크로 나간 쿼리.
//     두 층의 차이가 request cache 적중분이다. 계측은 요청/응답을 변형하지 않는다.
const cohortAwareFetch = makeCohortAwareFetch(
  makeTracingFetch(globalThis.fetch.bind(globalThis), "net"),
);
const referenceAwareFetch = makeReferenceAwareFetch(cohortAwareFetch);
const instrumentedFetch = makeTracingFetch(referenceAwareFetch, "logical");

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
          if (process.env.MEASURE_QUERIES) {
            const table = String(args[0] ?? "?");
            const stack = (new Error().stack ?? "").split("\n");
            // lib/*.ts 프레임만 추려 호출 체인 근사(파일:함수 근처).
            const chain = stack
              .map((l) => {
                const m = l.match(/(?:lib|app)[\\/][^\s()]+\.ts:\d+/);
                return m ? m[0].replace(/\\/g, "/") : null;
              })
              .filter((x): x is string => x !== null && !x.includes("supabaseAdmin.ts"))
              .slice(0, 5);
            const g = globalThis as unknown as {
              __q?: { table: string; chain: string[] }[];
            };
            g.__q = g.__q ?? [];
            g.__q.push({ table, chain });
          }
          return fn.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  },
);
