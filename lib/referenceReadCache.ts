import { AsyncLocalStorage } from "node:async_hooks";

// ─────────────────────────────────────────────────────────────────────
// 쓰기 요청(라인 개설/취소) 전용 **참조 테이블** 읽기 공유 캐시.
//
// 배경(2026-07-28 실측, LINE_OPEN_TRACE): 라인 개설 1회가 17~25개의 Supabase 쿼리를 **완전 직렬**로
//   실행하고(overlap 1.00x), 그중 상당수가 같은 요청 안에서 같은 행을 다시 읽는다:
//     weeks ×5 · user_profiles ×3 · cluster4_lines ×3 · test_user_markers ×2 · activity_types ×2
//   원격 Supabase 왕복이 건당 85~350ms 라 이 중복만으로 1초 이상이 그냥 날아간다.
//
// 설계: 이미 있는 코호트 캐시(cohortRequestCache)와 같은 fetch 층 공유 방식이되,
//   **"이 요청이 절대 쓰지 않는 테이블"만** 캐시한다(REFERENCE_TABLES 화이트리스트).
//   → write-then-read 정합 위험이 구조적으로 0 이다. 개설/취소가 쓰는 테이블
//     (cluster4_lines · cluster4_line_targets · cluster4_experience_* · cluster4_competency_* ·
//      cluster4_weekly_card_snapshots · process_point_awards · user_weekly_points ·
//      user_week_statuses · user_growth_stats · *_logs)은 **캐시하지 않는다** —
//     저장 직후 다시 읽어야 하는 값(예: 역량 countOpenedCompetencyState)이 항상 실제 DB 를 본다.
//
// 결과 동등성: 같은 URL(모든 필터·select 포함) 요청만 공유하므로 반환 rows 가 byte-identical 이다.
//   판정/DTO/snapshot 내용은 바뀌지 않는다 — 왕복 횟수만 줄어든다.
// 스코프 밖(runWithReferenceReadCache 미적용)에서는 완전 no-op(기존 동작 불변).
// ─────────────────────────────────────────────────────────────────────

// 라인 개설/취소 요청이 **읽기만** 하는 테이블. 여기 없는 테이블은 캐시하지 않는다(보수적 기본값).
const REFERENCE_TABLES = new Set([
  "admin_users",
  "activity_types",
  "weeks",
  "season_definitions",
  "official_rest_periods",
  "line_opening_windows",
  "cluster4_week_opening_configs",
  "test_user_markers",
  "user_profiles",
  "teams",
  "team_parts",
  "line_registrations",
  "cluster4_experience_line_masters",
  "cluster4_competency_line_masters",
  "org_week_thresholds",
]);

type BufferedResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};

type CacheStore = {
  map: Map<string, Promise<BufferedResponse>>;
  hits: number;
  misses: number;
};

const als = new AsyncLocalStorage<CacheStore>();

export type ReferenceCacheStats = { hits: number; misses: number };

/** 쓰기 라우트 핸들러를 감싸면 그 안의 참조 테이블 GET 이 요청 단위로 1회만 실행된다. */
export async function runWithReferenceReadCache<T>(
  fn: () => Promise<T>,
  onStats?: (stats: ReferenceCacheStats) => void,
): Promise<T> {
  const store: CacheStore = { map: new Map(), hits: 0, misses: 0 };
  try {
    return await als.run(store, fn);
  } finally {
    onStats?.({ hits: store.hits, misses: store.misses });
  }
}

function tableOf(url: string): string | null {
  const m = url.match(/\/rest\/v1\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function keyOf(url: string, headers: Headers): string {
  const range = headers.get("range") ?? "";
  const prefer = headers.get("prefer") ?? "";
  return `GET ${url}\nR:${range}\nP:${prefer}`;
}

/** supabaseAdmin fetch 체인에 끼우는 래퍼. 스코프 밖·비 GET·비참조 테이블은 통과. */
export function makeReferenceAwareFetch(realFetch: typeof fetch): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const store = als.getStore();
    const method = (init?.method ?? "GET").toUpperCase();
    if (!store || method !== "GET") {
      return realFetch(input as RequestInfo | URL, init);
    }
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const table = tableOf(url);
    if (!table || !REFERENCE_TABLES.has(table)) {
      return realFetch(input as RequestInfo | URL, init);
    }

    const headers = new Headers(
      (init?.headers as HeadersInit | undefined) ??
        (typeof input === "object" && !(input instanceof URL)
          ? (input as Request).headers
          : undefined),
    );
    const key = keyOf(url, headers);

    let promise = store.map.get(key);
    if (promise) {
      store.hits += 1;
    } else {
      store.misses += 1;
      promise = (async (): Promise<BufferedResponse> => {
        const res = await realFetch(input as RequestInfo | URL, init);
        // 바디는 디코딩된 텍스트라 content-encoding/length 를 복사하면 재구성 Response 와 불일치한다.
        const respHeaders = [...res.headers.entries()].filter(
          ([k]) => k !== "content-encoding" && k !== "content-length",
        );
        const buffered: BufferedResponse = {
          status: res.status,
          statusText: res.statusText,
          headers: respHeaders,
          body: await res.text(),
        };
        // 실패 응답은 공유하지 않는다(다음 호출이 재시도할 수 있게).
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
