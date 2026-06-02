// Browser-safe permission helper for Cluster4 4-hub (info / competency / experience / career)
// edit gating. Single source of truth shared by admin Cluster4 ActivityTab and the public
// portal submission API.
//
// Permission model (DB canonical):
//   - cluster4_line_targets row with target_mode='user', target_user_id=<user> is the
//     authorization grant. No separate cluster4_line_assignments / cluster4_line_permissions
//     table exists; the DB trigger validate_cluster4_line_submission already enforces
//     submission.user_id == target_user_id.
//   - cluster4_lines.submission_opens_at / submission_closes_at is the time gate.
//   - user_edit_windows.cluster4.work_<hub> is an operator OVERRIDE: when active it lets
//     the user edit even if the submission window is closed (e.g. "운영자가 임시 편집권을
//     부여했다"). It does NOT grant ownership — it only relaxes the time gate.

import type { Cluster4LinePartType } from "@/lib/cluster4LinesTypes";
import type { UserActivityModalKey } from "@/lib/userActivityDetailsTypes";

export type Cluster4LineCanEditReason =
  | "ok"
  | "line_inactive"
  | "not_owner"
  | "window_not_open"
  | "window_closed"
  | "target_missing"
  | "unsupported_target_mode";

export type Cluster4LineCanEditResult = {
  canEdit: boolean;
  reason: Cluster4LineCanEditReason;
};

// Minimal shape required by canEditCluster4Line. Compatible with the
// cluster4_line_targets + cluster4_lines join used by both the admin bundle and the
// portal helpers. line === null is treated as line_inactive (a target row without a
// joined line is effectively unusable).
export type Cluster4LinePermissionTarget = {
  target_mode: "user" | "rule";
  target_user_id: string | null;
  line: {
    is_active: boolean;
    submission_opens_at: string;
    submission_closes_at: string;
  } | null;
};

function parseTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

export function canEditCluster4Line(
  target: Cluster4LinePermissionTarget | null | undefined,
  profileUserId: string | null | undefined,
  now: number | Date = Date.now(),
): Cluster4LineCanEditResult {
  if (!target) {
    return { canEdit: false, reason: "target_missing" };
  }
  if (target.target_mode !== "user") {
    return { canEdit: false, reason: "unsupported_target_mode" };
  }
  if (!target.line || target.line.is_active === false) {
    return { canEdit: false, reason: "line_inactive" };
  }
  if (!profileUserId || target.target_user_id !== profileUserId) {
    return { canEdit: false, reason: "not_owner" };
  }
  const current = typeof now === "number" ? now : now.getTime();
  const opens = parseTime(target.line.submission_opens_at);
  const closes = parseTime(target.line.submission_closes_at);
  if (Number.isFinite(opens) && current < opens) {
    return { canEdit: false, reason: "window_not_open" };
  }
  if (Number.isFinite(closes) && current > closes) {
    return { canEdit: false, reason: "window_closed" };
  }
  return { canEdit: true, reason: "ok" };
}

// ─────────────────────────────────────────────────────────────────────────
// Hub ↔ part_type ↔ user_edit_windows.resource_key mapping
// ─────────────────────────────────────────────────────────────────────────

export const CLUSTER4_HUB_PART_TYPES: readonly Cluster4LinePartType[] = [
  "info",
  "competency",
  "experience",
  "career",
];

export const PART_TYPE_TO_EDIT_WINDOW_KEY = {
  info: "cluster4.work_info",
  competency: "cluster4.work_ability",
  experience: "cluster4.work_exp",
  career: "cluster4.work_career",
} as const;

export type Cluster4HubEditWindowKey =
  (typeof PART_TYPE_TO_EDIT_WINDOW_KEY)[Cluster4LinePartType];

export const CLUSTER4_HUB_EDIT_WINDOW_KEYS: readonly Cluster4HubEditWindowKey[] = [
  PART_TYPE_TO_EDIT_WINDOW_KEY.info,
  PART_TYPE_TO_EDIT_WINDOW_KEY.competency,
  PART_TYPE_TO_EDIT_WINDOW_KEY.experience,
  PART_TYPE_TO_EDIT_WINDOW_KEY.career,
];

export function partTypeToEditWindowResourceKey(
  partType: Cluster4LinePartType,
): Cluster4HubEditWindowKey {
  return PART_TYPE_TO_EDIT_WINDOW_KEY[partType];
}

// ActivityTab uses UserActivityModalKey-style identifiers ("work_info" / "work_ability" /
// "work_exp" / "work_career"). Career carries an extra slot for career_records rows;
// in either case the underlying hub maps the same way.
const MODAL_KEY_TO_PART_TYPE: Record<
  UserActivityModalKey | "work_career",
  Cluster4LinePartType
> = {
  work_info: "info",
  work_ability: "competency",
  work_exp: "experience",
  work_career: "career",
};

export function modalKeyToPartType(
  modal: UserActivityModalKey | "work_career",
): Cluster4LinePartType {
  return MODAL_KEY_TO_PART_TYPE[modal];
}

// ─────────────────────────────────────────────────────────────────────────
// Edit-window snapshot (server fetches and bundles; client evaluates).
// Kept structurally compatible with EditWindowDto so bundle producers can pass
// EditWindowDto directly.
// ─────────────────────────────────────────────────────────────────────────

export type Cluster4EditWindowSnapshot = {
  openedAt: string;
  expiresAt: string;
} | null;

export function isEditWindowActive(
  window: Cluster4EditWindowSnapshot,
  now: number | Date = Date.now(),
): boolean {
  if (!window) return false;
  const current = typeof now === "number" ? now : now.getTime();
  const opened = parseTime(window.openedAt);
  const expires = parseTime(window.expiresAt);
  if (!Number.isFinite(opened) || !Number.isFinite(expires)) return false;
  return current >= opened && current <= expires;
}

// ─────────────────────────────────────────────────────────────────────────
// Combined hub-level evaluator. Used by the admin Cluster4 ActivityTab to decide
// whether the operator can edit / add / delete rows in a hub (info / competency /
// experience / career). DIFFERENT from canEditCluster4Line, which is the strict
// per-target gate used by the portal submission API (where ownership is mandatory
// because the API writes to a specific cluster4_line_submissions row).
//
// Admin policy:
//   - If a line target exists for the user in this hub AND its submission window
//     is open → canEdit (reason "ok"). The natural path.
//   - Else if the user_edit_windows.cluster4.work_<hub> override is currently active
//     → canEdit (reason "ok_override"). Operator explicitly granted edit rights.
//     This grants access even when no line target exists (e.g. legacy
//     user_activity_details rows whose week_id pre-dates the cluster4_line system).
//   - Otherwise canEdit=false, with the line-level reason surfaced for debugging.
//
// Portal/submission policy (NOT this function): use canEditCluster4Line directly;
// ownership of a target row is required because the submission must write against
// that specific target_id.
// ─────────────────────────────────────────────────────────────────────────

export type Cluster4HubEditDecisionReason =
  | Cluster4LineCanEditReason
  | "ok_override";

export type Cluster4HubEditDecision = {
  canEdit: boolean;
  reason: Cluster4HubEditDecisionReason;
  lineWindowCanEdit: boolean;
  editWindowOpen: boolean;
};

export function evaluateCluster4HubEdit(input: {
  target: Cluster4LinePermissionTarget | null | undefined;
  editWindow: Cluster4EditWindowSnapshot;
  profileUserId: string | null | undefined;
  now?: number | Date;
}): Cluster4HubEditDecision {
  const now = input.now ?? Date.now();
  const line = canEditCluster4Line(input.target, input.profileUserId, now);
  const override = isEditWindowActive(input.editWindow, now);

  if (line.canEdit) {
    return {
      canEdit: true,
      reason: "ok",
      lineWindowCanEdit: true,
      editWindowOpen: override,
    };
  }

  // 운영자가 명시적으로 편집권(edit-window override)을 부여한 상태 — 시간 게이트(window_closed /
  // window_not_open) 및 라인 부재(target_missing: 레거시 user_activity_details 등) / line_inactive 는
  // 우회 허용한다. 단 not_owner(타깃이 "다른 사용자" 소유)는 override 로도 우회하면 안 된다 —
  // override 는 본인 허브의 시간 게이트만 완화할 뿐, 타인 라인에 대한 소유권을 부여하지 않는다.
  // (이 게이트가 없으면 foreign viewer 가 본인 override 가 열린 동안 타 유저 lineTargetId 에 제출 가능.)
  if (override && line.reason !== "not_owner" && line.reason !== "unsupported_target_mode") {
    return {
      canEdit: true,
      reason: "ok_override",
      lineWindowCanEdit: false,
      editWindowOpen: true,
    };
  }

  return {
    canEdit: false,
    reason: line.reason,
    lineWindowCanEdit: false,
    editWindowOpen: false,
  };
}
