// Browser-safe constants and types for the /admin/settings/edit-windows view.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

// 범용 edit-window 시스템.
// resource_key 단위로 사용자에게 "지금부터 N시간 / N일 동안 수정 가능" 권한을 부여한다.
// 1차 적용 resource: cluster2.review_links.
// 향후 cluster3 / cluster4 등은 EDITABLE_RESOURCES 에 항목을 추가하기만 하면 된다.

export type EditableResource = {
  key: string;
  label: string;
  description: string;
};

export const EDITABLE_RESOURCES: readonly EditableResource[] = [
  {
    key: "cluster2.review_links",
    label: "Cluster2 · Review Links",
    description: "Cluster2 의 10개 review link 슬롯 편집 권한",
  },
] as const;

export const DEFAULT_RESOURCE_KEY = EDITABLE_RESOURCES[0].key;

export function isEditableResourceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EDITABLE_RESOURCES.some((r) => r.key === value)
  );
}

export function getResourceLabel(key: string): string {
  return EDITABLE_RESOURCES.find((r) => r.key === key)?.label ?? key;
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
