// 단일 출처. 앱 어디에서든 이 상수를 사용한다.
export const ORGANIZATIONS = ["encre", "oranke", "phalanx"] as const;

export type OrganizationSlug = (typeof ORGANIZATIONS)[number];

export const ORGANIZATION_LABEL: Record<OrganizationSlug, string> = {
  encre: "Encre",
  oranke: "Oranke",
  phalanx: "Phalanx",
};

// organization_slug = null 에 대응하는 표시 라벨.
// 모든 어드민 드롭다운/표 표시는 본 상수를 사용한다 (이전: "선택 안 함"/"소속 없음"/"미지정" 혼재).
// "공통" 의미: 특정 조직에 소속되지 않음 = 조직 횡단으로 동작.
export const ORGANIZATION_COMMON_LABEL = "공통";

export function isOrganizationSlug(v: unknown): v is OrganizationSlug {
  return typeof v === "string" && (ORGANIZATIONS as readonly string[]).includes(v);
}

// organization_slug → 고객(front) 페이지 URL suffix.
// DB 의 org slug(oranke/encre/phalanx) 는 그대로 유지하고, URL 노출용 suffix 만
// canonical 규칙으로 매핑한다. 프론트 라우트 형태: /cluster-<n>-<suffix>.
// 이 매핑은 프론트의 organization config 와 동일해야 하므로 여기(단일 출처)에서만 정의한다.
//   oranke  → marketing     → /cluster-4-marketing
//   encre   → entertainment → /cluster-4-entertainment
//   phalanx → planning       → /cluster-4-planning
export const ORGANIZATION_ROUTE_SUFFIX: Record<OrganizationSlug, string> = {
  oranke: "marketing",
  encre: "entertainment",
  phalanx: "planning",
};

// 미지정/미매핑 조직의 기본 suffix. (legacy bare /cluster-4 == marketing)
export const DEFAULT_ROUTE_SUFFIX = "marketing";

// slug → URL suffix. 알 수 없는/없는 slug 는 기본 suffix 로 폴백한다.
export function organizationRouteSuffix(slug: string | null | undefined): string {
  return isOrganizationSlug(slug)
    ? ORGANIZATION_ROUTE_SUFFIX[slug]
    : DEFAULT_ROUTE_SUFFIX;
}
