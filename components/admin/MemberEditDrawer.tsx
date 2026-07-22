"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ORGANIZATIONS,
  ORGANIZATION_COMMON_LABEL,
  organizationLabelKo,
} from "@/lib/organizations";
import { ACCOUNT_STATUSES } from "@/lib/adminAppUsersTypes";
import {
  GROWTH_STATUS_LABELS,
  MANUAL_OVERRIDE_STATUSES,
  isManualOverrideStatus,
} from "@/shared/growth.contracts";
import {
  MEMBER_ASSIGNABLE_ROLES,
  isMemberAssignableRole,
} from "@/lib/adminMembersTypes";
import { USER_FACING_ROLE_LABELS } from "@/lib/adminPermissionsTypes";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { getApiErrorMessage } from "@/lib/apiError";

export type EditableMember = {
  userId: string;
  displayName: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  growthStatus: string | null;
  suspendedWeekId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  role: string | null;
  currentTeamName: string | null;
  currentPartName: string | null;
};

type Form = {
  organization_slug: string;
  status: string;
  growth_status: string;
  growth_status_reason: string;
  suspended_week_id: string;
  contact_email: string;
  contact_phone: string;
  role: string;
};

const ORG_NONE = "__none__";
const STATUS_NONE = "__none__";
const WEEK_NONE = "__none__";
// 성장 중단 적용 주차를 고를 수 있는 growth_status 값.
const SUSPENDED_STATUS = "suspended";

type WeekOption = { weekId: string; label: string };
// 4종 외(ambassador/admin/super_admin 등)의 역할은 이 화면에서 변경 불가 — 잠금 표시.
const ROLE_LOCKED = "__locked__";

function roleLabel(role: string | null): string {
  if (!role) return "미지정";
  return (USER_FACING_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

function toForm(member: EditableMember): Form {
  return {
    organization_slug: member.organizationSlug ?? ORG_NONE,
    status: member.status ?? STATUS_NONE,
    growth_status: member.growthStatus ?? STATUS_NONE,
    growth_status_reason: "",
    suspended_week_id: member.suspendedWeekId ?? WEEK_NONE,
    contact_email: member.contactEmail ?? "",
    contact_phone: member.contactPhone ?? "",
    // 4종 역할이면 편집 가능, 그 외(보존 역할)는 잠금.
    role: isMemberAssignableRole(member.role) ? member.role : ROLE_LOCKED,
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function diffPatch(initial: Form, next: Form) {
  const patch: Record<string, string | null> = {};

  const initialOrg = initial.organization_slug === ORG_NONE ? null : initial.organization_slug;
  const nextOrg = next.organization_slug === ORG_NONE ? null : next.organization_slug;
  if (initialOrg !== nextOrg) patch.organization_slug = nextOrg;

  const initialStatus = initial.status === STATUS_NONE ? null : initial.status;
  const nextStatus = next.status === STATUS_NONE ? null : next.status;
  if (initialStatus !== nextStatus) patch.status = nextStatus;

  const initialGrowth = initial.growth_status === STATUS_NONE ? null : initial.growth_status;
  const nextGrowth = next.growth_status === STATUS_NONE ? null : next.growth_status;
  if (initialGrowth !== nextGrowth) {
    patch.growth_status = nextGrowth;
    // 오버라이드 변경 시에만 사유 동봉 (audit 기록용 — 빈 값은 null).
    patch.growth_status_reason = emptyToNull(next.growth_status_reason);
  }

  // 성장 중단 적용 주차(suspended_week_id):
  //   - growth_status 가 suspended 가 아니면 주차는 무의미 → 기존 값이 있으면 null 로 해제.
  //   - suspended 면 선택된 주차(WEEK_NONE → null)를 반영.
  const initialWeek = initial.suspended_week_id === WEEK_NONE ? null : initial.suspended_week_id;
  const nextWeek =
    nextGrowth === SUSPENDED_STATUS
      ? next.suspended_week_id === WEEK_NONE
        ? null
        : next.suspended_week_id
      : null; // 중단이 아니면 항상 해제
  if (initialWeek !== nextWeek) patch.suspended_week_id = nextWeek;

  if (initial.contact_email !== next.contact_email) {
    patch.contact_email = emptyToNull(next.contact_email);
  }
  if (initial.contact_phone !== next.contact_phone) {
    patch.contact_phone = emptyToNull(next.contact_phone);
  }

  // 잠긴 역할(ROLE_LOCKED)은 절대 patch 에 싣지 않는다(보존 역할 보호).
  if (
    next.role !== ROLE_LOCKED &&
    initial.role !== next.role &&
    isMemberAssignableRole(next.role)
  ) {
    patch.role = next.role;
  }

  return patch;
}

type Props = {
  member: EditableMember | null;
  onClose: () => void;
  onSaved: (updated: EditableMember) => void;
};

// 외부 컴포넌트는 mount/unmount 게이트만 담당하고, 실제 폼은 Inner 가 들고 있는다.
// member 가 바뀌면 key 로 remount 되어 useState 초기값이 다시 계산된다.
export default function MemberEditDrawer({ member, onClose, onSaved }: Props) {
  if (!member) return null;
  return (
    <MemberEditDrawerInner
      key={member.userId}
      member={member}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function MemberEditDrawerInner({
  member,
  onClose,
  onSaved,
}: {
  member: EditableMember;
  onClose: () => void;
  onSaved: (updated: EditableMember) => void;
}) {
  const devMode = useAdminDevMode();
  const confirm = useConfirm();
  const initial = useMemo(() => toForm(member), [member]);
  const [form, setForm] = useState<Form>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 성장 중단 적용 주차 후보 — 이 멤버의 주차 카드(weekly-cards)에서 가져온다.
  //   growth_status=suspended 를 선택했을 때만 1회 지연 로드(불필요 호출 방지).
  const [weekOptions, setWeekOptions] = useState<WeekOption[] | null>(null);
  const [weeksLoading, setWeeksLoading] = useState(false);
  const [weeksError, setWeeksError] = useState<string | null>(null);

  const dirty = useMemo(
    () => Object.keys(diffPatch(initial, form)).length > 0,
    [initial, form],
  );

  // 닫기 — 입력값이 있을 때만 한 번 더 확인(없으면 그냥 닫기).
  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirm(CONFIRM.close))) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 성장 중단 선택 시 주차 후보를 로드(이미 로드했으면 재사용). 다른 화면 데이터/계산 무변경 —
  // 고객과 동일한 weekly-cards 응답에서 (weekId, 표시 제목)만 추출해 드롭다운 옵션으로 쓴다.
  useEffect(() => {
    if (form.growth_status !== SUSPENDED_STATUS) return;
    if (weekOptions !== null || weeksLoading) return;
    let aborted = false;
    setWeeksLoading(true);
    setWeeksError(null);
    fetch(`/api/cluster4/weekly-cards?userId=${encodeURIComponent(member.userId)}`)
      .then((res) => res.json())
      .then((json) => {
        if (aborted) return;
        if (!json?.success || !Array.isArray(json.data)) {
          setWeeksError(json?.error?.message ?? "주차 목록을 불러오지 못했습니다.");
          setWeekOptions([]);
          return;
        }
        const opts: WeekOption[] = (json.data as Array<Record<string, unknown>>)
          .filter((c) => typeof c.weekId === "string" && (c.weekId as string).length > 0)
          .map((c) => ({
            weekId: c.weekId as string,
            label:
              (typeof c.displayTitle === "string" && c.displayTitle) ||
              (typeof c.weekLabel === "string" && c.weekLabel) ||
              `${c.weekNumber ?? "?"}주차`,
          }));
        setWeekOptions(opts);
      })
      .catch((e) => {
        if (aborted) return;
        setWeeksError(e instanceof Error ? e.message : "주차 목록을 불러오지 못했습니다.");
        setWeekOptions([]);
      })
      .finally(() => {
        if (!aborted) setWeeksLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [form.growth_status, weekOptions, weeksLoading, member.userId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const patch = diffPatch(initial, form);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    // 저장 전 한 번 더 확인.
    if (!(await confirm(CONFIRM.save))) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/members/${encodeURIComponent(member.userId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save");
      }
      const updated = json.data as {
        userId: string;
        displayName: string | null;
        authEmail: string | null;
        organizationSlug: string | null;
        status: string | null;
        growthStatus: string | null;
        suspendedWeekId: string | null;
        contactEmail: string | null;
        contactPhone: string | null;
        role: string | null;
        currentTeamName: string | null;
        currentPartName: string | null;
      };
      onSaved({
        userId: updated.userId,
        displayName: updated.displayName,
        authEmail: updated.authEmail,
        organizationSlug: updated.organizationSlug,
        status: updated.status,
        growthStatus: updated.growthStatus,
        suspendedWeekId: updated.suspendedWeekId,
        contactEmail: updated.contactEmail,
        contactPhone: updated.contactPhone,
        role: updated.role,
        currentTeamName: updated.currentTeamName,
        currentPartName: updated.currentPartName,
      });
    } catch (err) {
      console.error("[members] edit save failed", err);
      setError(getApiErrorMessage(err, "회원 정보를 저장하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="멤버 정보 수정"
      className="fixed inset-0 z-50 flex"
    >
      {/* 배경 클릭/드래그로는 닫히지 않는다. 닫기는 X·취소·저장 버튼 또는 Esc 로만. */}
      <div className="absolute inset-0 bg-foreground/40" />
      <div className="relative ml-auto flex h-full modal-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">멤버 정보 수정</h3>
            <p className="text-xs text-muted-foreground">
              {member.displayName ?? "(이름 없음)"}
              {devMode && (
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  {member.userId}
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={saving}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <form
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col overflow-y-auto"
        >
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {devMode ? "로그인 이메일(auth_email): " : "로그인 이메일: "}
              <span className="font-mono">{member.authEmail ?? "—"}</span>
              <div className="mt-1 text-[10px]">
                {devMode
                  ? "auth_email 은 로그인 연결 정보이므로 이 화면에서 직접 수정하지 않습니다."
                  : "로그인 이메일은 계정 연결 정보라 이 화면에서 직접 바꿀 수 없습니다."}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-org">
                {devMode ? "소속 (organization_slug)" : "소속"}
              </Label>
              <Select
                value={form.organization_slug}
                onValueChange={(v: string | null) =>
                  setForm((prev) => ({
                    ...prev,
                    organization_slug: v ?? ORG_NONE,
                  }))
                }
              >
                <SelectTrigger id="member-org">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_NONE}>
                    {ORGANIZATION_COMMON_LABEL}
                  </SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {organizationLabelKo(slug)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-role">{devMode ? "역할 (role)" : "역할"}</Label>
              {form.role === ROLE_LOCKED ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <span className="font-medium">{roleLabel(member.role)}</span>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {devMode
                      ? "ambassador/admin/super_admin 등 보존 역할은 이 화면에서 변경하지 않습니다(계정/권한 관리에서 처리)."
                      : "이 역할은 이 화면에서 변경할 수 없습니다."}
                  </div>
                </div>
              ) : (
                <Select
                  value={form.role}
                  onValueChange={(v: string | null) =>
                    setForm((prev) => ({ ...prev, role: v ?? prev.role }))
                  }
                >
                  <SelectTrigger id="member-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMBER_ASSIGNABLE_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {roleLabel(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[10px] text-muted-foreground">
                현재 팀: <span className="font-medium">{member.currentTeamName ?? "—"}</span>
                {" / "}
                파트: <span className="font-medium">{member.currentPartName ?? "—"}</span>
                <br />
                에이전트·파트장은 같은 파트에 1명, 팀장은 같은 팀에 1명만 지정할 수 있습니다.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-status">{devMode ? "상태 (status)" : "상태"}</Label>
              <Select
                value={form.status}
                onValueChange={(v: string | null) =>
                  setForm((prev) => ({ ...prev, status: v ?? STATUS_NONE }))
                }
              >
                <SelectTrigger id="member-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_NONE}>미지정</SelectItem>
                  {ACCOUNT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-growth">
                {devMode
                  ? "성장 상태 오버라이드 (growth_status)"
                  : "성장 상태 오버라이드"}
              </Label>
              <Select
                value={form.growth_status}
                onValueChange={(v: string | null) =>
                  setForm((prev) => ({
                    ...prev,
                    growth_status: v ?? STATUS_NONE,
                  }))
                }
              >
                <SelectTrigger id="member-growth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_NONE}>미지정 (자동 계산)</SelectItem>
                  {MANUAL_OVERRIDE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {GROWTH_STATUS_LABELS[s]} ({s})
                    </SelectItem>
                  ))}
                  {/* legacy 값(seasonal_rest 등) 보유 행: 현재값 표시용 — 저장은 3종+해제만 허용 */}
                  {form.growth_status !== STATUS_NONE &&
                    !isManualOverrideStatus(form.growth_status) && (
                      <SelectItem value={form.growth_status} disabled>
                        {form.growth_status} (legacy — 자동 계산으로 대체됨)
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                오버라이드 3종(졸업/중단/유보) 외 상태는 자동 계산됩니다. 졸업
                절차 중(graduating)은 29주차 승인 완료 시 자동 표시 — 수동 지정
                불가.
              </p>
              {(initial.growth_status === STATUS_NONE
                ? null
                : initial.growth_status) !==
                (form.growth_status === STATUS_NONE
                  ? null
                  : form.growth_status) && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="member-growth-reason">
                    {devMode
                      ? "변경 사유 (growth_status_reason)"
                      : "변경 사유"}
                  </Label>
                  <Input
                    id="member-growth-reason"
                    value={form.growth_status_reason}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        growth_status_reason: e.target.value,
                      }))
                    }
                    placeholder="감사 로그에 기록됩니다 (선택)"
                  />
                </div>
              )}

              {/* 성장 중단(suspended) 선택 시에만 — 어느 주차에서 중단됐는지 지정.
                  고객 카드 목록은 이 주차 카드 1장에만 "성장 중단" 배지를 표시한다(이전 확정 주차는 원 상태 유지).
                  미지정이면 카드에는 표시되지 않고 상단/프로필 배지만 성장 중단으로 남는다. */}
              {form.growth_status === SUSPENDED_STATUS && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="member-suspended-week">
                    {devMode ? "성장 중단 적용 주차 (suspended_week_id)" : "성장 중단 적용 주차"}
                  </Label>
                  <Select
                    value={form.suspended_week_id}
                    onValueChange={(v: string | null) =>
                      setForm((prev) => ({ ...prev, suspended_week_id: v ?? WEEK_NONE }))
                    }
                    disabled={weeksLoading}
                  >
                    <SelectTrigger id="member-suspended-week">
                      <SelectValue placeholder={weeksLoading ? "주차 불러오는 중…" : "주차 선택"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={WEEK_NONE}>미지정 (카드 미표시)</SelectItem>
                      {(weekOptions ?? []).map((w) => (
                        <SelectItem key={w.weekId} value={w.weekId}>
                          {w.label}
                        </SelectItem>
                      ))}
                      {/* 현재 저장된 주차가 목록(확정 카드)에 없을 때도 현재값을 보존·표시 */}
                      {form.suspended_week_id !== WEEK_NONE &&
                        !(weekOptions ?? []).some((w) => w.weekId === form.suspended_week_id) && (
                          <SelectItem value={form.suspended_week_id} disabled>
                            {devMode ? form.suspended_week_id : "현재 지정된 주차"}
                          </SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    이 멤버의 확정 주차 카드 목록입니다. 중단이 적용된 주차를 고르면 그 카드만 "성장 중단"으로
                    표시되고, 이전 성공/실패/휴식 주차는 그대로 유지됩니다.
                  </p>
                  {weeksError && (
                    <p className="text-xs text-red-600">{weeksError}</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-contact-email">
                {devMode ? "연락 이메일 (contact_email)" : "연락 이메일"}
              </Label>
              <Input
                id="member-contact-email"
                type="email"
                value={form.contact_email}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    contact_email: e.target.value,
                  }))
                }
                placeholder={devMode ? "비워두면 null" : "비워두면 미지정"}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-contact-phone">
                {devMode ? "연락 전화 (contact_phone)" : "연락 전화"}
              </Label>
              <Input
                id="member-contact-phone"
                type="tel"
                value={form.contact_phone}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    contact_phone: e.target.value,
                  }))
                }
                placeholder={devMode ? "비워두면 null" : "비워두면 미지정"}
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestClose()}
              disabled={saving}
            >
              취소
            </Button>
            <Button type="submit" loading={saving} disabled={saving || !dirty}>
              저장
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
