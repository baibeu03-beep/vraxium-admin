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
