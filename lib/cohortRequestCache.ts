import { AsyncLocalStorage } from "node:async_hooks";

// 코호트 배치(예: 검수 완료의 코호트 snapshot 재계산) 동안만 활성화되는 요청 단위 read 캐시.
//
// 배경(2026-07-09 실측): per-user snapshot 재계산은 같은 주차의 전역/코호트-불변 데이터를
//   (official_rest_periods · season_definitions · activity_types · weeks · line_registrations ·
//    cluster4_lines · cluster4_line_targets 등) 유저마다 다시 조회한다. 85명이면 85배.
//
// 설계: supabaseAdmin 의 fetch 를 감싸(cohortAwareFetch), 캐시가 활성인 동안 **동일한 GET 요청**
//   (method+url+Range/Prefer 헤더 동일 = 완전히 같은 쿼리)을 1회만 실제 실행하고, 그 응답 바디를
//   버퍼링해 각 소비자에게 동일 내용의 새 Response 를 돌려준다.
//     · 조회 방식만 바꾸고 SQL/필터/계산은 그대로 → 반환 rows 동일 → snapshot JSON byte-identical.
//     · url 에 모든 필터(user_id, org, is_qa_test 등)가 인코딩되므로 유저별/mode별/org별 쿼리는
//       서로 다른 키 → 절대 섞이지 않는다(mode=test·운영 동일 코드 경로 유지, 결과 분리).
//     · 쓰기(POST/PATCH/DELETE)와 HEAD(count)·캐시 비활성 구간은 통과(no-op) → 기존 동작 불변.
//     · 캐시는 배치 1회 수명(runWithCohortRequestCache 스코프)만 살고 폐기 → 배치 내 write-then-read
//       정합 이슈 없음(카드 계산은 official_rest_periods 등 읽기 대상 테이블을 쓰지 않는다).

type BufferedResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};

type CacheStore = {
  map: Map<string, Promise<BufferedResponse>>;
  hits: number; // 캐시 적중(실제 네트워크 절약) 횟수 — 계측용.
  misses: number; // 실제 실행 횟수.
};

const als = new AsyncLocalStorage<CacheStore>();

export type CohortCacheStats = { hits: number; misses: number };

// 코호트 배치를 이 스코프로 감싸면 내부의 supabaseAdmin GET 이 요청 단위로 공유된다.
//   onStats: 배치 종료 시 적중/실제 실행 횟수를 전달(계측·로그용, 선택).
export async function runWithCohortRequestCache<T>(
  fn: () => Promise<T>,
  onStats?: (stats: CohortCacheStats) => void,
): Promise<T> {
  const store: CacheStore = { map: new Map(), hits: 0, misses: 0 };
  try {
    return await als.run(store, fn);
  } finally {
    onStats?.({ hits: store.hits, misses: store.misses });
  }
}

function keyOf(url: string, method: string, headers: Headers): string {
  // 페이지네이션(Range)·count/representation(Prefer)까지 포함해야 완전 동일 요청만 공유한다.
  const range = headers.get("range") ?? "";
  const prefer = headers.get("prefer") ?? "";
  return `${method} ${url}\nR:${range}\nP:${prefer}`;
}

// supabaseAdmin 의 global.fetch 로 주입되는 래퍼. 캐시 비활성 구간에서는 realFetch 그대로.
export function makeCohortAwareFetch(realFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const store = als.getStore();
    const method = (init?.method ?? "GET").toUpperCase();
    // read(GET)만 캐시. 쓰기/HEAD/비활성은 통과.
    if (!store || method !== "GET") {
      return realFetch(input as RequestInfo | URL, init);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = new Headers(
      (init?.headers as HeadersInit | undefined) ??
        (typeof input === "object" && !(input instanceof URL) ? (input as Request).headers : undefined),
    );
    const key = keyOf(url, method, headers);

    let promise = store.map.get(key);
    if (promise) {
      store.hits += 1;
    } else {
      store.misses += 1;
      promise = (async (): Promise<BufferedResponse> => {
        const res = await realFetch(input as RequestInfo | URL, init);
        // 바디는 이미 디코딩된 텍스트라, content-encoding/content-length 를 그대로 복사하면
        //   재구성 Response 와 불일치한다 → 두 헤더만 제거(count 용 content-range 는 보존).
        const headers = [...res.headers.entries()].filter(
          ([k]) => k !== "content-encoding" && k !== "content-length",
        );
        const buffered: BufferedResponse = {
          status: res.status,
          statusText: res.statusText,
          headers,
          body: await res.text(),
        };
        // 실패 응답은 캐시에서 제거(다음 유저가 재시도할 수 있게) — 성공만 공유.
        if (res.status >= 400) store.map.delete(key);
        return buffered;
      })().catch((e) => {
        store.map.delete(key);
        throw e;
      });
      store.map.set(key, promise);
    }

    const b = await promise;
    return new Response(b.body, {
      status: b.status,
      statusText: b.statusText,
      headers: b.headers,
    });
  }) as typeof fetch;
}
