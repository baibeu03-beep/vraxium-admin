"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
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
import { ORGANIZATIONS, ORGANIZATION_LABEL } from "@/lib/organizations";
import { APP_USER_STATUSES } from "@/lib/adminAppUsersTypes";
import { cn } from "@/lib/utils";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

export type EditableMember = {
  userId: string;
  displayName: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  growthStatus: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

type Form = {
  organization_slug: string;
  status: string;
  growth_status: string;
  contact_email: string;
  contact_phone: string;
};

const ORG_NONE = "__none__";
const STATUS_NONE = "__none__";

function toForm(member: EditableMember): Form {
  return {
    organization_slug: member.organizationSlug ?? ORG_NONE,
    status: member.status ?? STATUS_NONE,
    growth_status: member.growthStatus ?? STATUS_NONE,
    contact_email: member.contactEmail ?? "",
    contact_phone: member.contactPhone ?? "",
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
  if (initialGrowth !== nextGrowth) patch.growth_status = nextGrowth;

  if (initial.contact_email !== next.contact_email) {
    patch.contact_email = emptyToNull(next.contact_email);
  }
  if (initial.contact_phone !== next.contact_phone) {
    patch.contact_phone = emptyToNull(next.contact_phone);
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
  const initial = useMemo(() => toForm(member), [member]);
  const [form, setForm] = useState<Form>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const dirty = useMemo(
    () => Object.keys(diffPatch(initial, form)).length > 0,
    [initial, form],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const patch = diffPatch(initial, form);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
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
        contactEmail: string | null;
        contactPhone: string | null;
      };
      onSaved({
        userId: updated.userId,
        displayName: updated.displayName,
        authEmail: updated.authEmail,
        organizationSlug: updated.organizationSlug,
        status: updated.status,
        growthStatus: updated.growthStatus,
        contactEmail: updated.contactEmail,
        contactPhone: updated.contactPhone,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      <div
        className="absolute inset-0 bg-foreground/40"
        onClick={() => !saving && onClose()}
      />
      <div className="relative ml-auto flex h-full w-full max-w-md flex-col bg-background shadow-xl">
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
            onClick={onClose}
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
                  <SelectItem value={ORG_NONE}>미지정</SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {ORGANIZATION_LABEL[slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  {APP_USER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-growth">
                {devMode ? "성장 상태 (growth_status)" : "성장 상태"}
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
                  <SelectItem value={STATUS_NONE}>미지정</SelectItem>
                  {APP_USER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              onClick={onClose}
              disabled={saving}
            >
              취소
            </Button>
            <Button type="submit" disabled={saving || !dirty}>
              {saving && (
                <Loader2 className={cn("h-4 w-4 animate-spin")} aria-hidden />
              )}
              저장
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
