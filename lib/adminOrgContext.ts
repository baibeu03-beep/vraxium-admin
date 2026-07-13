import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// 어드민 "조직 컨텍스트" 단일 출처.
//
// 외부 URL / 사이드바 / 브라우저 주소창은 항상 쿼리파라미터 `?org={slug}` 로
// 현재 조직을 표현한다. (크루 목록만 기존 path `/admin/crews/{org}` 를 유지.)
// API 내부 컨벤션은 `organization` 이므로, client manager 가 `?org` 를 읽어
// API 호출 시에만 `?organization=` 으로 변환한다 — 파라미터를 혼용하지 않는다.
//
// org=null = 통합 모드(통합 검수 시스템). 데이터는 전체 조직.
// org=slug = 조직 모드. 공유 페이지 데이터가 (org == slug) OR (common) 로 제한된다.
// ─────────────────────────────────────────────────────────────────────

// useSearchParams() 반환값(ReadonlyURLSearchParams)·URLSearchParams 양쪽과 호환되는 최소 형태.
type SearchParamsLike = { get(name: string): string | null } | null | undefined;

// 현재 URL 의 `?org` 를 읽어 검증된 OrganizationSlug 로 돌려준다. 없거나 유효하지 않으면 null.
export function readOrgParam(searchParams: SearchParamsLike): OrganizationSlug | null {
  const raw = searchParams?.get("org")?.trim();
  return isOrganizationSlug(raw) ? raw : null;
}

// 조직 모드일 때 href 에 `?org={slug}` 를 부착한다(기존 쿼리스트링 보존).
// org 가 null(통합 모드)이면 원본 href 를 그대로 돌려준다 — 통합 모드 링크는 byte-identical.
export function orgHref(href: string, org: OrganizationSlug | null): string {
  if (!org) return href;
  const [path, existing] = href.split("?");
  const params = new URLSearchParams(existing ?? "");
  params.set("org", org);
  return `${path}?${params.toString()}`;
}

// 현재 화면의 "조직 컨텍스트"(orgFocus) 단일 출처 — 사이드바 [통합]/[개별] 판정과 동일 규칙.
//   1) path `/admin/crews/{org}` (크루 목록만 path 기반 진입 — 기존 정책)
//   2) 그 외 공유 페이지는 `?org={slug}`
// 둘 다 없으면 null = 통합(통합 검수 시스템). path 가 우선한다.
//   ⚠ 반드시 "출발 화면"의 pathname/searchParams 로 판정한다 — 목적지 주소 문자열로 통합/개별을
//     재판정하지 않는다(예: 목적지 pathname 에 조직명이 들어가도 새 org 를 주입하지 않음).
export function resolveAdminOrgFocus(
  pathname: string | null | undefined,
  searchParams: SearchParamsLike,
): OrganizationSlug | null {
  const m = (pathname ?? "").match(/^\/admin\/crews\/([^/]+)/);
  const pathOrg = m && isOrganizationSlug(m[1]) ? m[1] : null;
  return pathOrg ?? readOrgParam(searchParams);
}

// 링크/라우팅 이동 시 "출발 화면 → 목적지"로 그대로 전달하는 어드민 컨텍스트 파라미터.
//   통합/개별(org) · 모집단 모드(mode) · 테스트 대행/데모(actAsTestUserId/demoUserId)만 대상이다.
//   page/sort/search/tab 등 "목록 전용 · 목적지에서 의미가 달라지는" 파라미터는 절대 복사하지 않는다.
export const ADMIN_CONTEXT_PARAMS = [
  "mode",
  "org",
  "actAsTestUserId",
  "demoUserId",
] as const;

// 목적지 href 에 "출발 화면"의 어드민 컨텍스트를 얹어 돌려준다(수동 문자열 연결 반복 제거).
//   핵심 원칙: 목적지 주소로 통합/개별을 재판정하지 않고, 출발 화면의 orgFocus 를 그대로 전달한다.
//   · org  : 출발 orgFocus(path 또는 ?org)를 `?org` 로 부착. 단 목적지 path 가 이미
//            `/admin/crews/{org}` 로 org 를 인코딩하면 부착하지 않는다(path 우선·이중 인코딩 방지).
//   · mode : operating(기본)은 부착하지 않는다 → 운영 링크는 byte-identical.
//   · actAsTestUserId / demoUserId : 출발 화면 값이 있으면 유지.
//   · 목적지가 자체 쿼리로 이미 지정한 컨텍스트 값은 덮어쓰지 않는다(목적지 우선·충돌 없는 병합).
export function buildAdminContextHref({
  targetPath,
  pathname,
  searchParams,
}: {
  // 목적지 경로(선택적으로 자체 쿼리 포함 가능: 예 `/admin/x?tab=open`).
  targetPath: string;
  // 출발 화면 pathname (orgFocus 판정용).
  pathname: string | null | undefined;
  // 출발 화면 searchParams (컨텍스트 파라미터 원본).
  searchParams: SearchParamsLike;
}): string {
  const [path, targetQuery] = targetPath.split("?");
  const params = new URLSearchParams(targetQuery ?? "");

  // org — 목적지 path 가 이미 org 를 path 로 인코딩하면 부착 생략.
  const destEncodesOrg = /^\/admin\/crews\/[^/]+/.test(path);
  const orgFocus = resolveAdminOrgFocus(pathname, searchParams);
  if (orgFocus && !destEncodesOrg && !params.has("org")) {
    params.set("org", orgFocus);
  }

  // 나머지 컨텍스트 파라미터 — 목적지가 이미 명시하지 않은 것만 출발 값으로 채운다.
  for (const key of ADMIN_CONTEXT_PARAMS) {
    if (key === "org") continue; // 위에서 orgFocus 로 처리(단순 ?org 복사 아님)
    if (params.has(key)) continue; // 목적지 우선
    const raw = searchParams?.get(key)?.trim();
    if (!raw) continue;
    if (key === "mode" && raw !== "test") continue; // operating=기본 → 미부착
    params.set(key, raw);
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
