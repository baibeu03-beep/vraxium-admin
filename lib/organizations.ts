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

// ── 역방향: 고객 페이지 slug → organization ──────────────────────────────
// 위 ORGANIZATION_ROUTE_SUFFIX 의 역매핑. 프론트 라우트 suffix(canonical + legacy)를
// 내부 org slug 로 환원한다. 페이지 slug ↔ 실제 소속 org 접근 게이트(lib/pageAccess)의
// 유일한 매핑 정의소다 — 프론트 lib/cluster-route 의 SUFFIX_TO_ORG 와 동일 의미를 유지한다.
//   marketing / -marketing / ok / -ok        → oranke
//   entertainment / -entertainment / ec / -ec → encre
//   planning / -planning / px / -px           → phalanx
const PAGE_SLUG_TO_ORGANIZATION: Record<string, OrganizationSlug> = {
  marketing: "oranke",
  ok: "oranke",
  entertainment: "encre",
  ec: "encre",
  planning: "phalanx",
  px: "phalanx",
};

// 페이지 slug 를 organization 으로 환원한다. 선행 "-" 와 대소문자를 정규화한다.
//   recognized=false → 알 수 없는 slug(접근 제약 미적용 대상).
export function pageSlugToOrganization(slug: string | null | undefined): {
  org: OrganizationSlug | null;
  recognized: boolean;
} {
  if (typeof slug !== "string") return { org: null, recognized: false };
  const normalized = slug.trim().replace(/^-+/, "").toLowerCase();
  if (!normalized) return { org: null, recognized: false };
  const org = PAGE_SLUG_TO_ORGANIZATION[normalized];
  return org ? { org, recognized: true } : { org: null, recognized: false };
}
