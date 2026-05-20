// Browser-safe constants and types for the /admin/settings/edit-windows view.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

// 범용 edit-window 시스템.
// resource_key 단위로 사용자에게 "지금부터 N시간 / N일 동안 수정 가능" 권한을 부여한다.
// 1차 적용 resource: cluster2.review_links.
// 향후 cluster3 / cluster4 등은 EDITABLE_RESOURCES 에 항목을 추가하기만 하면 된다.

export type EditableResource = {
  key: string;
  // 운영자에게 노출되는 기본 라벨/설명 — "무엇을 할 수 있는가" 중심.
  label: string;
  description: string;
  // ?dev=true 에서만 노출되는 개발자용 라벨/설명 — 기존 DB/cluster 식별자 유지.
  devLabel: string;
  devDescription: string;
};

// 호스트(사용자) 앱 PUT 핸들러는 card_type 에 따라 아래 두 키 중 하나를 골라
// 동일한 user_edit_windows row 를 조회한다. (cluster3 channel cards 는 제한 대상 아님)
// Cluster4 키 (weekly_reviews / activity_details / season_review) 는 Front/Host
// 측에서 이미 동일 문자열로 user_edit_windows 를 조회하므로 여기에 entry 만 추가
// 하면 작성 기간 관리 UI 가 즉시 노출된다. user_edit_windows 스키마/마이그레이션
// 변경은 필요 없다.
export const EDITABLE_RESOURCES: readonly EditableResource[] = [
  {
    key: "cluster2.review_links",
    label: "클럽 리뷰 링크",
    description: "주차별 Club Review 링크 10개 작성 권한을 관리합니다.",
    devLabel: "Cluster2 · Review Links",
    devDescription: "Cluster2 의 10개 review link 슬롯 편집 권한",
  },
  {
    key: "cluster3.output_cards",
    label: "포트폴리오 대표 카드",
    description: "포트폴리오 대표 카드 5장 작성 권한을 관리합니다.",
    devLabel: "Cluster3 · Output Cards",
    devDescription:
      "Cluster3 Output (portfolio_top_cards.card_type='output', 5장) 편집 권한",
  },
  {
    key: "cluster3.detail_cards",
    label: "포트폴리오 상세 카드",
    description: "포트폴리오 상세 카드 10장 작성 권한을 관리합니다.",
    devLabel: "Cluster3 · Detail Cards",
    devDescription:
      "Cluster3 Detail (portfolio_top_cards.card_type='detail', 10장) 편집 권한",
  },
  {
    key: "cluster4.weekly_reviews",
    label: "주간 회고",
    description: "주차별 회고 작성 권한을 관리합니다.",
    devLabel: "Cluster4 · 주간 리뷰",
    devDescription: "Cluster4 weekly_reviews (주차별 회고) 편집 권한",
  },
  {
    key: "cluster4.activity_details",
    label: "활동 상세",
    description: "활동별 상세 입력 작성 권한을 관리합니다.",
    devLabel: "Cluster4 · 활동 상세",
    devDescription: "Cluster4 user_activity_details (활동별 상세 입력) 편집 권한",
  },
  {
    key: "cluster4.season_review",
    label: "시즌 종합 평가",
    description: "시즌 종합 평가(평점 / 코멘트) 작성 권한을 관리합니다.",
    devLabel: "Cluster4 · 시즌 리뷰",
    devDescription:
      "Cluster4 시즌 종합 (user_season_histories.rating / review) 편집 권한",
  },
] as const;

export const DEFAULT_RESOURCE_KEY = EDITABLE_RESOURCES[0].key;

export function isEditableResourceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EDITABLE_RESOURCES.some((r) => r.key === value)
  );
}

// devMode=true 면 기존 cluster/DB 식별자 기반 라벨, false 면 운영자 친화 라벨.
// 대시보드처럼 devMode 컨텍스트가 없는 server component 는 인자 없이 호출해 운영자 라벨을 받는다.
export function getResourceLabel(key: string, devMode = false): string {
  const r = EDITABLE_RESOURCES.find((x) => x.key === key);
  if (!r) return key;
  return devMode ? r.devLabel : r.label;
}

export function getResourceDescription(key: string, devMode = false): string {
  const r = EDITABLE_RESOURCES.find((x) => x.key === key);
  if (!r) return "";
  return devMode ? r.devDescription : r.description;
}

// ─────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────

export type EditWindowDto = {
  id: string;
  userId: string;
  resourceKey: string;
  openedAt: string; // ISO
  expiresAt: string; // ISO
  grantedBy: string | null;
  note: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

// 한 사용자의 한 resource 에 대한 현재 상태 — UI 가 곧바로 렌더할 수 있는 형태.
export type EditWindowUserRow = {
  userId: string;
  displayName: string | null;
  authEmail: string | null;
  contactEmail: string | null;
  organizationSlug: string | null;
  window: EditWindowDto | null;
};

export type ListEditWindowsResult = {
  resourceKey: string;
  rows: EditWindowUserRow[];
  total: number;
  limit: number;
  offset: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────

export type EditWindowStatus = "open" | "closed" | "expired" | "none";

export function computeEditWindowStatus(
  window: EditWindowDto | null,
  now: Date = new Date(),
): EditWindowStatus {
  if (!window) return "none";
  const opened = new Date(window.openedAt);
  const expires = new Date(window.expiresAt);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(expires.getTime())) {
    return "none";
  }
  if (now < opened) return "closed";
  if (now > expires) return "expired";
  return "open";
}

export function statusLabel(status: EditWindowStatus): string {
  switch (status) {
    case "open":
      return "열림";
    case "closed":
      return "닫힘";
    case "expired":
      return "만료됨";
    case "none":
      return "권한 없음";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Quick actions
// ─────────────────────────────────────────────────────────────────────────

export type QuickActionKey = "open_24h" | "open_7d" | "open_until_midnight";

export const QUICK_ACTIONS: { key: QuickActionKey; label: string }[] = [
  { key: "open_24h", label: "지금부터 24시간 열기" },
  { key: "open_7d", label: "지금부터 7일 열기" },
  { key: "open_until_midnight", label: "오늘 자정까지 열기" },
];

// 클라이언트/서버 모두 같은 결과를 내도록, now 기준으로 opened/expires 계산.
export function computeQuickActionRange(
  action: QuickActionKey,
  now: Date = new Date(),
): { openedAt: Date; expiresAt: Date } {
  const opened = new Date(now);
  switch (action) {
    case "open_24h": {
      const expires = new Date(opened.getTime() + 24 * 60 * 60 * 1000);
      return { openedAt: opened, expiresAt: expires };
    }
    case "open_7d": {
      const expires = new Date(opened.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { openedAt: opened, expiresAt: expires };
    }
    case "open_until_midnight": {
      // 로컬 자정. 서버에서도 호출되므로 호출자(UI)가 now 를 넘기는 게 안전.
      const expires = new Date(opened);
      expires.setHours(23, 59, 59, 999);
      return { openedAt: opened, expiresAt: expires };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH payload
// ─────────────────────────────────────────────────────────────────────────

export type EditWindowUpsertPayload = {
  resource_key: string;
  opened_at: string;
  expires_at: string;
  note?: string | null;
};

export type EditWindowClosePayload = {
  resource_key: string;
  action: "close";
};

export type EditWindowPatchBody = EditWindowUpsertPayload | EditWindowClosePayload;
