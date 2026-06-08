// Browser-safe constants and types for the /admin/settings/edit-windows view.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

export type EditableResource = {
  key: string;
  section: "cluster2" | "cluster3" | "cluster4";
  group: "weekly" | "season" | "activity" | "review_links" | "portfolio" | "education";
  order: number;
  label: string;
  description: string;
  devLabel: string;
  devDescription: string;
  // legacy: 기존 grants 와 backward-compat 을 위해 EDITABLE_RESOURCES 에 남겨두지만
  // 새 grant 생성 흐름에서는 노출하지 않는다. 새 4개 키(work_info/work_ability/
  // work_exp/work_career) 가 운영되면 향후 단계에서 완전 제거.
  legacy?: boolean;
};

export const EDITABLE_RESOURCES: readonly EditableResource[] = [
  {
    key: "cluster2.review_links",
    section: "cluster2",
    group: "review_links",
    order: 10,
    label: "\uD074\uB7FD \uB9AC\uBDF0 \uB9C1\uD06C",
    description:
      "\uC8FC\uCC28\uBCC4 Club Review \uB9C1\uD06C 10\uAC1C \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster2 / Review Links",
    devDescription: "Cluster2 review link permissions",
  },
  {
    key: "cluster2.primary_education",
    section: "cluster2",
    group: "education",
    order: 11,
    // "1번 학력 = 대표 학력". 비주간(전역) window — review_links 와 동일 패턴.
    label: "1번 학력 수정",
    description:
      "대표(1번) 학력 정보 수정 가능 기간을 관리합니다.",
    devLabel: "Cluster2 / Primary Education",
    devDescription:
      "Cluster2 primary education edit permissions (user_profiles 1st/primary education record)",
  },
  {
    key: "cluster3.output_cards",
    section: "cluster3",
    group: "portfolio",
    order: 20,
    label: "\uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uB300\uD45C \uCE74\uB4DC",
    description:
      "\uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uB300\uD45C \uCE74\uB4DC 5\uAC1C \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster3 / Output Cards",
    devDescription:
      "Cluster3 output card permissions (portfolio_top_cards.card_type='output')",
  },
  {
    key: "cluster3.detail_cards",
    section: "cluster3",
    group: "portfolio",
    order: 21,
    label: "\uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uC0C1\uC138 \uCE74\uB4DC",
    description:
      "\uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uC0C1\uC138 \uCE74\uB4DC 10\uAC1C \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster3 / Detail Cards",
    devDescription:
      "Cluster3 detail card permissions (portfolio_top_cards.card_type='detail')",
  },
  {
    key: "cluster4.weekly_reviews",
    section: "cluster4",
    group: "weekly",
    order: 30,
    label: "\uC704\uD074\uB9AC \uB9AC\uBDF0",
    description:
      "\uC8FC\uCC28\uBCC4 \uC704\uD074\uB9AC \uB9AC\uBDF0 \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Weekly Review",
    devDescription: "Cluster4 weekly_reviews permissions",
  },
  {
    key: "cluster4.weekly_colleagues",
    section: "cluster4",
    group: "weekly",
    order: 31,
    label: "\uC704\uD074\uB9AC \uC5F0\uACC4\uB3D9\uB8CC",
    description:
      "\uC8FC\uCC28\uBCC4 \uC704\uD074\uB9AC \uC5F0\uACC4\uB3D9\uB8CC \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Weekly Colleagues",
    devDescription: "Cluster4 weekly_colleagues permissions",
  },
  {
    key: "cluster4.weekly_reputation",
    section: "cluster4",
    group: "weekly",
    order: 32,
    label: "위클리 평판",
    description:
      "주차별 받은 위클리 평판 작성 권한을 관리합니다.",
    devLabel: "Cluster4 / Weekly Reputation",
    devDescription:
      "Cluster4 weekly_reputations permissions (peer-review row; reviewer-side gate lives in Front repo)",
  },
  {
    key: "cluster4.season_review",
    section: "cluster4",
    group: "season",
    order: 33,
    label: "\uC2DC\uC98C \uB9AC\uBDF0",
    description:
      "\uBCF8\uC778 \uC2DC\uC98C \uC885\uD569 \uD3C9\uAC00 \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Season Review",
    devDescription:
      "Cluster4 user_season_histories.rating / review permissions",
  },
  {
    key: "cluster4.season_reputation",
    section: "cluster4",
    group: "season",
    order: 34,
    label: "\uC2DC\uC98C \uD3C9\uD310",
    description:
      "\uC2DC\uC98C \uD3C9\uD310 \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Season Reputation",
    devDescription: "Cluster4 season_reputations permissions",
  },
  {
    key: "cluster4.activity_details",
    section: "cluster4",
    group: "activity",
    order: 35,
    label: "\uD65C\uB3D9 \uC0C1\uC138 (legacy)",
    description:
      "\uAE30\uC874 \uD65C\uB3D9\uBCC4 \uC0C1\uC138 \uC785\uB825 \uAD8C\uD55C \uD0A4 \u2014 \uC2E0\uADDC 4\uAC1C \uD0A4(work_info / work_ability / work_exp / work_career)\uB85C \uBD84\uB9AC\uB418\uBA70 \uBCF8 \uD0A4\uB294 \uAE30\uC874 grants \uBCF4\uC874\uC6A9 alias \uB85C \uC720\uC9C0\uB429\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Activity Details (legacy alias)",
    devDescription:
      "Cluster4 user_activity_details permissions (legacy single key; superseded by cluster4.work_info / .work_ability / .work_exp / .work_career)",
    legacy: true,
  },
  {
    key: "cluster4.work_info",
    section: "cluster4",
    group: "activity",
    order: 36,
    label: "\uC2E4\uBB34 \uC815\uBCF4 (Work Info)",
    description:
      "Cluster4-card \uC2E4\uBB34 \uC815\uBCF4 \uBAA8\uB2EC \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Work Info",
    devDescription:
      "Cluster4 work_info permissions (user_activity_details, info taxonomy)",
  },
  {
    key: "cluster4.work_ability",
    section: "cluster4",
    group: "activity",
    order: 37,
    label: "\uC2E4\uBB34 \uC5ED\uB7C9 (Work Ability)",
    description:
      "Cluster4-card \uC2E4\uBB34 \uC5ED\uB7C9 \uBAA8\uB2EC \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Work Ability",
    devDescription:
      "Cluster4 work_ability permissions (user_activity_details, competency taxonomy)",
  },
  {
    key: "cluster4.work_exp",
    section: "cluster4",
    group: "activity",
    order: 38,
    label: "\uC2E4\uBB34 \uACBD\uD5D8 (Work Exp)",
    description:
      "Cluster4-card \uC2E4\uBB34 \uACBD\uD5D8 \uBAA8\uB2EC \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4. rating(0~10) \uC800\uC7A5 \uACBD\uB85C\uB294 \uC774 \uD0A4\uB85C \uAC8C\uC774\uD2B8\uB429\uB2C8\uB2E4.",
    devLabel: "Cluster4 / Work Exp",
    devDescription:
      "Cluster4 work_exp permissions (user_activity_details, experience taxonomy + rating)",
  },
  {
    key: "cluster4.work_career",
    section: "cluster4",
    group: "activity",
    order: 39,
    label: "\uC2E4\uBB34 \uACBD\uB825 (Work Career)",
    description:
      "Cluster4-card \uC2E4\uBB34 \uACBD\uB825 \uBAA8\uB2EC \uC791\uC131 \uAD8C\uD55C\uC744 \uAD00\uB9AC\uD569\uB2C8\uB2E4. career_records grade / enhancement_status \uC800\uC7A5 \uACBD\uB85C.",
    devLabel: "Cluster4 / Work Career",
    devDescription:
      "Cluster4 work_career permissions (career_records grade / enhancement_status / career_code)",
  },
] as const;

export const DEFAULT_RESOURCE_KEY = EDITABLE_RESOURCES[0].key;

export function isEditableResourceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EDITABLE_RESOURCES.some((resource) => resource.key === value)
  );
}

export function getResourceLabel(key: string, devMode = false): string {
  const resource = EDITABLE_RESOURCES.find((item) => item.key === key);
  if (!resource) return key;
  return devMode ? resource.devLabel : resource.label;
}

export function getResourceDescription(key: string, devMode = false): string {
  const resource = EDITABLE_RESOURCES.find((item) => item.key === key);
  if (!resource) return "";
  return devMode ? resource.devDescription : resource.description;
}

export function getEditableResource(key: string): EditableResource | undefined {
  return EDITABLE_RESOURCES.find((resource) => resource.key === key);
}

// 4개 실무 허브(정보/역량/경험/경력) 작성기간 키. 주차 단위 추가 개방의 대상이다.
// 신규 grant 는 주차별(week_id 필수)로만 생성하되, 판정/조회는 (week_id=카드주차 OR
// week_id IS NULL 전역) 의 additive OR 로 본다 — 기존 전역 grant 하위호환 보존.
const WEEK_SCOPED_ACTIVITY_HUB_KEYS: ReadonlySet<string> = new Set([
  "cluster4.work_info",
  "cluster4.work_ability",
  "cluster4.work_exp",
  "cluster4.work_career",
]);

// 주차 단위로 권한을 여는 자원:
//   - group === "weekly" (주간 회고/동료/평판) — 원래부터 주차 필수.
//   - 4개 실무 허브(work_*) — 2026-06-08 주차별 추가 개방 도입(신규 grant 는 week_id 필수).
// 이 자원들은 admin write 시 week_id 가 필수이고, admin UI 가 주차 선택 드롭다운을 노출한다.
// 비주간 자원은 전역(week_id=NULL).
export function isWeekScopedResourceKey(key: string): boolean {
  if (WEEK_SCOPED_ACTIVITY_HUB_KEYS.has(key)) return true;
  const resource = EDITABLE_RESOURCES.find((item) => item.key === key);
  return resource?.group === "weekly";
}

// 이 resource_key 의 grant 가 weekly-cards snapshot 의 canEdit(허브 수정 버튼)에 반영되는가.
// 4개 실무 허브(work_*)만 cluster4 weekly-cards 의 evaluateCluster4HubEdit override 로 쓰이므로,
// 이 키를 열거나/닫을 때 대상 사용자의 snapshot 을 stale 처리해 버튼이 즉시 반영되게 한다.
export function affectsWeeklyCardsCanEdit(key: string): boolean {
  return WEEK_SCOPED_ACTIVITY_HUB_KEYS.has(key);
}

// admin 주차 선택 드롭다운 / 권한 판정에서 공용으로 쓰는 주차 옵션.
// label 예: "2026 봄 시즌 12주차". weekId = weeks.id (UUID).
export type WeekOption = {
  weekId: string;
  seasonKey: string | null;
  seasonLabel: string | null;
  weekNumber: number | null;
  startDate: string | null;
  endDate: string | null;
  label: string;
};

export const CLUSTER4_EDIT_RESOURCES = EDITABLE_RESOURCES.filter(
  (resource) => resource.section === "cluster4" && !resource.legacy,
);

export const CLUSTER4_WEEKLY_EDIT_RESOURCES = CLUSTER4_EDIT_RESOURCES.filter(
  (resource) => resource.group === "weekly",
);

export const CLUSTER4_SEASON_EDIT_RESOURCES = CLUSTER4_EDIT_RESOURCES.filter(
  (resource) => resource.group === "season",
);

// 4개 활동 모달(work_info / work_ability / work_exp / work_career)을 묶어 노출.
// legacy alias 인 cluster4.activity_details 는 본 목록에 포함되지 않으며,
// 기존 grants 데이터는 user_edit_windows 에 그대로 보존되어 admin 이 닫기/열기로
// 마이그레이션 가능하다 (EDITABLE_RESOURCES select 에는 legacy 도 나타남).
export const CLUSTER4_ACTIVITY_EDIT_RESOURCES = CLUSTER4_EDIT_RESOURCES.filter(
  (resource) => resource.group === "activity",
);

export type EditWindowDto = {
  id: string;
  userId: string;
  resourceKey: string;
  // 주간 자원이면 가리키는 주차(weeks.id) + 파생 시즌. 전역/비주간이면 null.
  weekId: string | null;
  seasonKey: string | null;
  openedAt: string;
  expiresAt: string;
  grantedBy: string | null;
  grantedByEmail: string | null;
  note: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

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
      return "\uC5F4\uB9BC";
    case "closed":
      return "\uB2EB\uD798";
    case "expired":
      return "\uB9CC\uB8CC";
    case "none":
      return "\uAD8C\uD55C \uC5C6\uC74C";
  }
}

export type QuickActionKey = "open_24h" | "open_7d" | "open_until_midnight";

export const QUICK_ACTIONS: { key: QuickActionKey; label: string }[] = [
  { key: "open_24h", label: "\uC9C0\uAE08\uBD80\uD130 24\uC2DC\uAC04 \uC5F4\uAE30" },
  { key: "open_7d", label: "\uC9C0\uAE08\uBD80\uD130 7\uC77C \uC5F4\uAE30" },
  {
    key: "open_until_midnight",
    label: "\uC624\uB298 \uC790\uC815\uAE4C\uC9C0 \uC5F4\uAE30",
  },
];

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
      const expires = new Date(opened);
      expires.setHours(23, 59, 59, 999);
      return { openedAt: opened, expiresAt: expires };
    }
  }
}

export type EditWindowUpsertPayload = {
  resource_key: string;
  // 주간 자원이면 필수, 비주간이면 생략/ null. season_key 는 서버에서 파생한다.
  week_id?: string | null;
  opened_at: string;
  expires_at: string;
  note?: string | null;
};

export type EditWindowClosePayload = {
  resource_key: string;
  week_id?: string | null;
  action: "close";
};

export type EditWindowPatchBody = EditWindowUpsertPayload | EditWindowClosePayload;
