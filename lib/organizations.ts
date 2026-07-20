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

// ── 조직 메타데이터(통합 SoT) ───────────────────────────────────────────────
// 조직 환경 배너(OrgEnvironmentBanner) 등 "조직 정체성"을 크게 드러내는 UI 의 단일 참조소.
//   · ko/en 은 위 원자 상수(ORGANIZATION_LABEL_KO / ORGANIZATION_LABEL)를 그대로 참조 → 값 중복 없음.
//   · icon: 조직 성격과 어울리는 이모지(즉시 구분용). encre=🌸(엔터/문화), oranke=🏴(마케팅/개척),
//     phalanx=🏛(기획/고전 밀집대형). 하드코딩 금지 규칙에 따라 조직별 의미를 여기 한 곳에만 둔다.
//   · bannerClass: 조직 대표색(배경/텍스트/테두리). 라이트·다크 동시 정의(정적 문자열 → Tailwind JIT 인식).
//     팔레트는 기존 ORGANIZATION_TEXT_CLASS(pink/amber/emerald)와 동일 계열로 일관.
//     ★ 배경은 라이트/다크 모두 **불투명(opaque)** — 배너가 sticky 로 콘텐츠 위에 겹칠 때 뒤가 비치면
//       안 되기 때문(다크도 /40 반투명 금지). 배너·홈 카드가 이 클래스를 공유(단일 색 SoT).
//   · cardHoverClass: 홈 조직 카드 hover 강조(배경·테두리). 배너에는 미사용(호버 없음).
export type OrganizationMeta = {
  ko: string;
  en: string;
  icon: string;
  bannerClass: string;
  cardHoverClass: string;
};

export const ORGANIZATION_META: Record<OrganizationSlug, OrganizationMeta> = {
  encre: {
    ko: ORGANIZATION_LABEL_KO.encre,
    en: ORGANIZATION_LABEL.encre,
    icon: "🌸",
    bannerClass:
      "bg-pink-100 text-pink-900 border-pink-300 dark:bg-pink-950 dark:text-pink-100 dark:border-pink-800",
    cardHoverClass:
      "hover:bg-pink-200 hover:border-pink-400 dark:hover:bg-pink-900 dark:hover:border-pink-700",
  },
  oranke: {
    ko: ORGANIZATION_LABEL_KO.oranke,
    en: ORGANIZATION_LABEL.oranke,
    icon: "🏴",
    bannerClass:
      "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800",
    cardHoverClass:
      "hover:bg-amber-200 hover:border-amber-400 dark:hover:bg-amber-900 dark:hover:border-amber-700",
  },
  phalanx: {
    ko: ORGANIZATION_LABEL_KO.phalanx,
    en: ORGANIZATION_LABEL.phalanx,
    icon: "🏛",
    bannerClass:
      "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-800",
    cardHoverClass:
      "hover:bg-emerald-200 hover:border-emerald-400 dark:hover:bg-emerald-900 dark:hover:border-emerald-700",
  },
};

// slug → 조직 메타. 미매핑/공통(통합 모드)은 null(호출부에서 배너 미표시).
export function organizationMeta(
  slug: string | null | undefined,
): OrganizationMeta | null {
  return isOrganizationSlug(slug) ? ORGANIZATION_META[slug] : null;
}

// ── /admin 홈 조직 선택 카드(통합 SoT) ──────────────────────────────────────
// 홈의 조직 선택 카드는 환경 배너와 **동일한 조직 메타(ORGANIZATION_META)** 를 재사용한다
//   — 조직명/색을 홈에서 별도 하드코딩하지 않는다. 실제 org(encre/oranke/phalanx)는 META 참조,
//   그 외 카드(통합/미개설 조직)만 여기서 정의한다.
//   variant: "org"=조직 대표색 활성 링크 · "neutral"=통합 검수(특정 조직 아님, 중립색) ·
//            "pending"=미개설(진입 불가, 공용 disabled 스타일 — 색은 조직색 미부여).
//   href: 있으면 활성(Link), null 이면 진입 불가(pending). 활성/비활성 판정·href 는 기존 그대로 유지.
//   en: 영문명(없으면 null — 예: A-Q). 영문명은 추측 생성 금지 — 미정의 조직은 한글명만 표시.
export type HomeLaunchCardVariant = "org" | "neutral" | "pending";

export type HomeLaunchCard = {
  key: string;
  ko: string;
  en: string | null;
  href: string | null;
  icon: string | null;
  variant: HomeLaunchCardVariant;
  // 활성(org/neutral) 색 클래스. pending 은 null(공용 disabled 스타일 사용).
  cardClass: string | null;
  cardHoverClass: string | null;
};

function orgLaunchCard(slug: OrganizationSlug, href: string): HomeLaunchCard {
  const m = ORGANIZATION_META[slug];
  return {
    key: slug,
    ko: m.ko,
    en: m.en,
    href,
    icon: m.icon,
    variant: "org",
    cardClass: m.bannerClass,
    cardHoverClass: m.cardHoverClass,
  };
}

export const HOME_LAUNCH_CARDS: HomeLaunchCard[] = [
  {
    key: "integrated",
    ko: "통합 검수 시스템",
    en: "전체 조직 통합 관리",
    href: "/admin/members",
    icon: "🗂️",
    variant: "neutral",
    cardClass: "bg-primary/5 text-foreground border-primary/30",
    cardHoverClass: "hover:bg-primary/10 hover:border-primary/50",
  },
  orgLaunchCard("encre", "/admin/crews/encre"),
  orgLaunchCard("oranke", "/admin/crews/oranke"),
  orgLaunchCard("phalanx", "/admin/crews/phalanx"),
  // 미개설(진입 불가) — 영문명은 사용자 확정값만 사용(추측 금지), A-Q 는 영문명 없음.
  { key: "squad", ko: "스쿼드", en: "Squad", href: null, icon: null, variant: "pending", cardClass: null, cardHoverClass: null },
  { key: "dionysos", ko: "디오니소스", en: "Dionysos", href: null, icon: null, variant: "pending", cardClass: null, cardHoverClass: null },
  { key: "aq", ko: "A-Q", en: null, href: null, icon: null, variant: "pending", cardClass: null, cardHoverClass: null },
  { key: "cocoontak", ko: "코쿤탁", en: "CocoonTak", href: null, icon: null, variant: "pending", cardClass: null, cardHoverClass: null },
];

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
