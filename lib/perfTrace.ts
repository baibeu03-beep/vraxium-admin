import { AsyncLocalStorage } from "node:async_hooks";

// ─────────────────────────────────────────────────────────────────────
// 요청 단위 성능 트레이스(계측 전용 — 비즈니스 로직 무영향).
//
// 목적: /api/cluster4/weekly-cards 한 요청의 실제 비용 분해.
//   · helper 별 wall time (중첩 span 트리)
//   · Supabase 쿼리별 latency / 테이블 / 필터 / 응답 바이트
//   · 동일 쿼리 반복 여부 (logical URL 중복)
//   · request cache 적중 여부 (logical 층 vs network 층 차이)
//   · Promise overlap / 순차 실행 구간 (쿼리 start·end 타임라인)
//
// 설계: AsyncLocalStorage 2개.
//   · dataAls  — 트레이스 수집 버퍼(span/query 배열). runWithPerfTrace 가 1회 설치.
//   · spanAls  — 현재 span 컨텍스트(부모 포인터). traceSpan 이 자식 스코프에 설치.
// 스토어가 없으면(=트레이스 비활성) 모든 API 가 no-op → 운영 경로 비용 0.
//
// fetch 계층은 2중으로 감싼다(supabaseAdmin 참고):
//   tracing("logical") → cohortAwareFetch → tracing("net") → real fetch
//   logical 은 supabase-js 가 "발행한" 쿼리 전부, net 은 "실제 네트워크로 나간" 쿼리.
//   두 층의 차이가 곧 request cache 적중분이다.
// ─────────────────────────────────────────────────────────────────────

export type TraceLayer = "logical" | "net";

export type TraceQuery = {
  seq: number;
  layer: TraceLayer;
  table: string;
  method: string;
  filters: string; // querystring (select= 제외) — 동일 쿼리 판정 키
  select: string;
  url: string;
  spanPath: string;
  startMs: number; // 트레이스 시작 기준 offset
  ttfbEndMs: number; // 응답 헤더 도착
  endMs: number; // 바디까지 완전 수신
  ms: number; // endMs - startMs
  bytes: number;
  status: number;
};

export type TraceSpan = {
  seq: number;
  name: string;
  path: string;
  parentSeq: number | null;
  depth: number;
  startMs: number;
  endMs: number;
  ms: number;
};

export type PerfTrace = {
  label: string;
  totalMs: number;
  spans: TraceSpan[];
  queries: TraceQuery[];
};

type Store = {
  label: string;
  origin: number; // performance.now() 기준점
  spans: TraceSpan[];
  queries: TraceQuery[];
  pending: Promise<unknown>[]; // 바디 측정 등 후행 작업
  seq: number;
};

type SpanCtx = { seq: number; path: string; depth: number };

const dataAls = new AsyncLocalStorage<Store>();
const spanAls = new AsyncLocalStorage<SpanCtx>();

function now(): number {
  return performance.now();
}

export function isTracing(): boolean {
  return dataAls.getStore() !== undefined;
}

// 트레이스 스코프. fn 결과와 수집된 트레이스를 함께 반환한다.
export async function runWithPerfTrace<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ result: T; trace: PerfTrace }> {
  const store: Store = {
    label,
    origin: now(),
    spans: [],
    queries: [],
    pending: [],
    seq: 0,
  };
  const result = await dataAls.run(store, fn);
  // 응답 바디 크기 측정 등 비동기 후행 작업을 모두 회수한 뒤 트레이스를 확정한다.
  await Promise.allSettled(store.pending);
  const totalMs = now() - store.origin;
  store.spans.sort((a, b) => a.startMs - b.startMs);
  store.queries.sort((a, b) => a.startMs - b.startMs);
  return { result, trace: { label, totalMs, spans: store.spans, queries: store.queries } };
}

// helper 1개를 span 으로 감싼다. 비활성이면 fn 을 그대로 실행(오버헤드 0).
export async function traceSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const store = dataAls.getStore();
  if (!store) return fn();
  const parent = spanAls.getStore() ?? null;
  const seq = store.seq++;
  const path = parent ? `${parent.path}/${name}` : name;
  const depth = parent ? parent.depth + 1 : 0;
  const startMs = now() - store.origin;
  const record = (endMs: number) => {
    store.spans.push({
      seq,
      name,
      path,
      parentSeq: parent ? parent.seq : null,
      depth,
      startMs,
      endMs,
      ms: endMs - startMs,
    });
  };
  try {
    return await spanAls.run({ seq, path, depth }, fn);
  } finally {
    record(now() - store.origin);
  }
}

// 동기 구간(직렬화·순수 계산 등) 측정.
export function traceSyncSpan<T>(name: string, fn: () => T): T {
  const store = dataAls.getStore();
  if (!store) return fn();
  const parent = spanAls.getStore() ?? null;
  const seq = store.seq++;
  const startMs = now() - store.origin;
  try {
    return fn();
  } finally {
    const endMs = now() - store.origin;
    store.spans.push({
      seq,
      name,
      path: parent ? `${parent.path}/${name}` : name,
      parentSeq: parent ? parent.seq : null,
      depth: parent ? parent.depth + 1 : 0,
      startMs,
      endMs,
      ms: endMs - startMs,
    });
  }
}

// PostgREST URL → { table, select, filters }
function parseRestUrl(url: string): { table: string; select: string; filters: string } {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/rest\/v1\/([^/?]+)/);
    const table = m ? decodeURIComponent(m[1]) : u.pathname;
    const params = new URLSearchParams(u.search);
    const select = params.get("select") ?? "";
    params.delete("select");
    const filters = params.toString();
    return { table, select, filters };
  } catch {
    return { table: url, select: "", filters: "" };
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// supabaseAdmin 의 fetch 체인에 끼우는 계측 래퍼. 트레이스 비활성이면 통과(no-op).
export function makeTracingFetch(realFetch: typeof fetch, layer: TraceLayer): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const store = dataAls.getStore();
    if (!store) return realFetch(input as RequestInfo | URL, init);

    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const spanPath = spanAls.getStore()?.path ?? "(root)";
    const seq = store.seq++;
    const startMs = now() - store.origin;

    const res = await realFetch(input as RequestInfo | URL, init);
    const ttfbEndMs = now() - store.origin;

    const { table, select, filters } = parseRestUrl(url);
    const entry: TraceQuery = {
      seq,
      layer,
      table,
      method,
      filters,
      select,
      url,
      spanPath,
      startMs,
      ttfbEndMs,
      endMs: ttfbEndMs,
      ms: ttfbEndMs - startMs,
      bytes: 0,
      status: res.status,
    };
    store.queries.push(entry);

    // 바디 수신 완료 시점/크기는 clone 으로 병렬 측정한다(원본 스트림 무간섭).
    // 호출부를 블로킹하지 않고, runWithPerfTrace 종료 시 회수한다.
    const probe = (async () => {
      try {
        const text = await res.clone().text();
        entry.bytes = Buffer.byteLength(text, "utf8");
        entry.endMs = now() - store.origin;
        entry.ms = entry.endMs - entry.startMs;
      } catch {
        /* 측정 실패는 무시 — ttfb 값 유지 */
      }
    })();
    store.pending.push(probe);

    return res;
  }) as typeof fetch;
}

// ── 리포트 포맷 ─────────────────────────────────────────────────────

function pad(n: number | string, w: number): string {
  return String(n).padStart(w);
}
function ms(n: number): string {
  return `${n.toFixed(1)}ms`;
}

// 동일 쿼리(logical) 반복 목록: table+filters+select 완전 일치 = 같은 쿼리.
export function duplicateQueries(trace: PerfTrace): Array<{
  key: string;
  table: string;
  count: number;
  totalMs: number;
  spanPaths: string[];
}> {
  const groups = new Map<string, TraceQuery[]>();
  for (const q of trace.queries) {
    if (q.layer !== "logical") continue;
    const key = `${q.method} ${q.table}?${q.filters}&select=${q.select}`;
    const arr = groups.get(key) ?? [];
    arr.push(q);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, arr]) => ({
      key,
      table: arr[0].table,
      count: arr.length,
      totalMs: arr.reduce((s, q) => s + q.ms, 0),
      spanPaths: [...new Set(arr.map((q) => q.spanPath))],
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

// 같은 테이블을 여러 helper(span)가 각기 읽는지 — select 가 달라 URL 캐시로는 안 잡히는 반복.
export function tableFanout(trace: PerfTrace): Array<{
  table: string;
  count: number;
  totalMs: number;
  spanPaths: string[];
}> {
  const groups = new Map<string, TraceQuery[]>();
  for (const q of trace.queries) {
    if (q.layer !== "logical") continue;
    const arr = groups.get(q.table) ?? [];
    arr.push(q);
    groups.set(q.table, arr);
  }
  return [...groups.entries()]
    .map(([table, arr]) => ({
      table,
      count: arr.length,
      totalMs: arr.reduce((s, q) => s + q.ms, 0),
      spanPaths: [...new Set(arr.map((q) => q.spanPath))],
    }))
    .sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);
}

// 병렬성 지표: 쿼리 구간 합 vs 쿼리 union 구간(겹침 병합) → overlap 비율.
export function concurrency(trace: PerfTrace): {
  sumMs: number;
  unionMs: number;
  factor: number; // sum/union — 1.0 = 완전 순차, N = 평균 N개 동시
  maxParallel: number;
} {
  const qs = trace.queries.filter((q) => q.layer === "net");
  const src = qs.length ? qs : trace.queries.filter((q) => q.layer === "logical");
  if (src.length === 0) return { sumMs: 0, unionMs: 0, factor: 0, maxParallel: 0 };
  const sumMs = src.reduce((s, q) => s + q.ms, 0);
  const iv = src
    .map((q) => [q.startMs, q.endMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let unionMs = 0;
  let [cs, ce] = iv[0];
  for (let i = 1; i < iv.length; i++) {
    const [s, e] = iv[i];
    if (s > ce) {
      unionMs += ce - cs;
      [cs, ce] = [s, e];
    } else if (e > ce) ce = e;
  }
  unionMs += ce - cs;
  // 최대 동시 실행 수 — sweep line
  const evts = src.flatMap((q) => [
    { t: q.startMs, d: 1 },
    { t: q.endMs, d: -1 },
  ]);
  evts.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let maxParallel = 0;
  for (const e of evts) {
    cur += e.d;
    if (cur > maxParallel) maxParallel = cur;
  }
  return { sumMs, unionMs, factor: unionMs > 0 ? sumMs / unionMs : 0, maxParallel };
}

// span 트리 + 쿼리 타임라인 + 요약을 사람이 읽는 텍스트로.
export function formatTrace(trace: PerfTrace): string {
  const out: string[] = [];
  const logical = trace.queries.filter((q) => q.layer === "logical");
  const net = trace.queries.filter((q) => q.layer === "net");
  const conc = concurrency(trace);

  out.push(`═══ ${trace.label} — total ${ms(trace.totalMs)} ═══`);
  out.push(
    `queries: logical=${logical.length} net=${net.length} cacheHits=${logical.length - net.length} bytes=${net.reduce((s, q) => s + q.bytes, 0).toLocaleString()}`,
  );
  out.push(
    `db time: sum=${ms(conc.sumMs)} union(wall)=${ms(conc.unionMs)} overlap=${conc.factor.toFixed(2)}x maxParallel=${conc.maxParallel}`,
  );
  out.push(
    `non-db time: ${ms(trace.totalMs - conc.unionMs)} (${((1 - conc.unionMs / trace.totalMs) * 100).toFixed(0)}% of wall)`,
  );

  out.push("");
  out.push("── call graph (helper wall time) ──");
  // span 트리: 부모 → 자식 순서로 DFS
  const byParent = new Map<number | null, TraceSpan[]>();
  for (const s of trace.spans) {
    const arr = byParent.get(s.parentSeq) ?? [];
    arr.push(s);
    byParent.set(s.parentSeq, arr);
  }
  const walk = (parentSeq: number | null, prefix: string) => {
    const kids = (byParent.get(parentSeq) ?? []).sort((a, b) => a.startMs - b.startMs);
    kids.forEach((s, i) => {
      const last = i === kids.length - 1;
      const qn = logical.filter((q) => q.spanPath === s.path).length;
      out.push(
        `${prefix}${last ? "└── " : "├── "}${s.name}  ${ms(s.ms)}` +
          `  [@${s.startMs.toFixed(0)}ms${qn ? `, ${qn}q` : ""}]`,
      );
      walk(s.seq, prefix + (last ? "    " : "│   "));
    });
  };
  walk(null, "");

  out.push("");
  out.push("── query timeline (logical) ──");
  out.push("  #   start     ms    bytes  table                          span");
  logical
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .forEach((q, i) => {
      const isDup =
        logical.filter(
          (o) => o.table === q.table && o.filters === q.filters && o.select === q.select,
        ).length > 1;
      out.push(
        `  ${pad(i + 1, 2)}  ${pad(q.startMs.toFixed(0), 6)}  ${pad(q.ms.toFixed(0), 5)}  ${pad(q.bytes.toLocaleString(), 7)}  ${(q.table + (isDup ? " ⟳DUP" : "")).padEnd(29)}  ${q.spanPath}`,
      );
    });

  const dups = duplicateQueries(trace);
  out.push("");
  out.push("── duplicate queries (identical url) ──");
  if (dups.length === 0) out.push("  (none)");
  for (const d of dups) {
    out.push(`  ×${d.count}  ${ms(d.totalMs)}  ${d.key.slice(0, 110)}`);
    out.push(`        callers: ${d.spanPaths.join(" , ")}`);
  }

  out.push("");
  out.push("── table fan-out (same table, any select) ──");
  for (const t of tableFanout(trace).filter((t) => t.count > 1)) {
    out.push(`  ×${t.count}  ${ms(t.totalMs)}  ${t.table}`);
    out.push(`        callers: ${t.spanPaths.join(" , ")}`);
  }

  out.push("");
  out.push("── bottleneck ranking (self time, excl. child spans) ──");
  const selfMs = (s: TraceSpan) => {
    const kids = byParent.get(s.seq) ?? [];
    return s.ms - kids.reduce((sum, k) => sum + k.ms, 0);
  };
  trace.spans
    .map((s) => ({
      s,
      self: selfMs(s),
      q: logical.filter((q) => q.spanPath.startsWith(s.path)).length,
    }))
    .sort((a, b) => b.self - a.self)
    .slice(0, 12)
    .forEach((r, i) => {
      out.push(
        `  ${pad(i + 1, 2)}. ${r.s.path.padEnd(52)} self=${ms(r.self).padStart(9)}  total=${ms(r.s.ms).padStart(9)}  ${r.q}q`,
      );
    });

  return out.join("\n");
}
