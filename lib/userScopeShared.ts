// 사용자 스코프 — 클라이언트/서버 공용 순수 헬퍼 (서버 전용 의존 없음).
// ─────────────────────────────────────────────────────────────────────
// resolveUserScope(서버·supabaseAdmin 사용)는 lib/userScope.ts 에 있다. 이 모듈은
// mode 파싱/링크 전파 등 순수 함수만 담아 "use client" 컴포넌트에서도 import 가능하게 한다.
//   (lib/userScope.ts 가 supabaseAdmin 을 import 하므로 클라이언트 번들에 넣으면 안 됨)
// ─────────────────────────────────────────────────────────────────────

export type ScopeMode = "operating" | "test";

// useSearchParams()(ReadonlyURLSearchParams)·URLSearchParams 양쪽 호환 최소 형태.
type SearchParamsLike = { get(name: string): string | null } | null | undefined;

// 문자열 → ScopeMode. 'test' 리터럴만 test, 그 외(오타·null·미지정)는 operating(fail-safe).
export function parseScopeMode(raw: string | null | undefined): ScopeMode {
  return (raw ?? "").trim() === "test" ? "test" : "operating";
}

// URL ?mode 파싱 (readOrgParam 미러). React/route 양쪽 동일 사용.
export function readScopeMode(searchParams: SearchParamsLike): ScopeMode {
  return parseScopeMode(searchParams?.get("mode") ?? null);
}

// 링크/탭 이동 시 mode 보존 (appendDevQuery 미러). operating(기본)이면 파라미터 미부착
// → 운영 링크는 byte-identical.
export function appendModeQuery(href: string, mode: ScopeMode): string {
  if (mode !== "test") return href;
  const [pathAndQuery, hash] = href.split("#");
  const [path, query] = pathAndQuery.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("mode") !== "test") params.set("mode", "test");
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}
