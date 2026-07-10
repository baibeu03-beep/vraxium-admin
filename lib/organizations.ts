// 단일 출처. 앱 어디에서든 이 상수를 사용한다.
export const ORGANIZATIONS = ["encre", "oranke", "phalanx"] as const;

export type OrganizationSlug = (typeof ORGANIZATIONS)[number];

export const ORGANIZATION_LABEL: Record<OrganizationSlug, string> = {
  encre: "Encre",
  oranke: "Oranke",
  phalanx: "Phalanx",
};

// 조직 한글 표시명(공식) — 단일 SoT. 어드민 배지/탭 등 한글 조직명 표시는 본 상수를 사용한다.
//   (기존에 여러 컴포넌트가 동일 매핑을 중복 정의하던 것을 여기로 통합.)
export const ORGANIZATION_LABEL_KO: Record<OrganizationSlug, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

// 조직 대표색(글자색) — 단일 SoT. RestManagementManager 의 조직 액센트(violet/amber/emerald)와
//   동일 팔레트. 조직명 라벨은 배경/테두리 없이 이 텍스트 색만으로 조직을 구분한다(보조 강조).
export const ORGANIZATION_TEXT_CLASS: Record<OrganizationSlug, string> = {
  encre: "text-pink-600",
  oranke: "text-amber-600",
  phalanx: "text-emerald-600",
};

// slug → 한글 표시명. 미매핑/공통은 null(호출부에서 미표시/공통 처리).
export function organizationLabelKo(slug: string | null | undefined): string | null {
  return isOrganizationSlug(slug) ? ORGANIZATION_LABEL_KO[slug] : null;
}

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

// ── 역방향: 크루 페이지 slug → organization ──────────────────────────────
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
