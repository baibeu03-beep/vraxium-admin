"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  Copy,
  KeyRound,
  Pencil,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { cn } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { useActionToast } from "@/lib/actionToast";
import {
  ORGANIZATIONS,
  ORGANIZATION_COMMON_LABEL,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import {
  ADMIN_USERS_ROLES,
  ADMIN_USERS_ROLE_LABELS,
  type AccountDto,
  type AdminUsersRole,
  type CreateAccountResult,
  type ListAccountsResult,
} from "@/lib/adminAccountsTypes";

// /admin/settings/accounts — 운영 계정 관리 UI.
//   본 페이지는 어드민 페이지에 로그인할 수 있는 admin_users row 만 다룬다.
//   일반 소셜 로그인 회원(프론트 사용자)은 노출되지 않는다.
//
//   GET  /api/admin/accounts              로 admin_users 기반 운영 계정 목록 조회
//   POST /api/admin/accounts              로 신규 운영 계정 생성 (super_admin 단독)
//   PATCH /api/admin/accounts/[user_id]   로 admin_role/is_active/메타 변경 (super_admin 단독)
//   POST /api/admin/accounts/[user_id]/password-reset  로 비밀번호 재설정

const PAGE_SIZE = 50;
// 백엔드 validateDisplayName(DISPLAY_NAME_MAX_LENGTH)과 동일하게 유지.
const DISPLAY_NAME_MAX_LENGTH = 50;
const ROLE_ALL = "__all__";
const ACTIVE_ALL = "__all__";
const ORG_NONE = "__none__"; // organization_slug=null sentinel (CreateDrawer + 인라인 Select 공용)

const ROLE_BADGE_CLASS: Record<AdminUsersRole, string> = {
  owner: "bg-violet-100 text-violet-800 ring-violet-200",
  admin: "bg-blue-100 text-blue-800 ring-blue-200",
  viewer: "bg-muted text-muted-foreground ring-border",
};

type Banner = { kind: "success" | "error"; message: string } | null;

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "—";
}

// createdAt·updatedAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "—" });
}

function orgLabel(slug: string | null) {
  if (!slug) return ORGANIZATION_COMMON_LABEL;
  if (isOrganizationSlug(slug)) return ORGANIZATION_LABEL[slug];
  return slug;
}

export default function AccountsManager() {
  const confirm = useConfirm();
  const t = useActionToast();
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>(ROLE_ALL);
  const [activeFilter, setActiveFilter] = useState<string>(ACTIVE_ALL);

  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());

  // 이름 인라인 수정 — 한 번에 한 행만 편집한다.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<{
    label: string;
    email: string;
    password: string;
  } | null>(null);

  // ── debounce search ───────────────────────────────────────────────
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery((prev) => {
        const next = query.trim();
        if (prev !== next) setOffset(0);
        return next;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  // ── load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (roleFilter !== ROLE_ALL) params.set("admin_role", roleFilter);
      if (activeFilter !== ACTIVE_ALL) params.set("active", activeFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      try {
        const res = await fetch("/api/admin/accounts?" + params.toString(), {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load accounts");
        }
        if (cancelled) return;
        const data = json.data as ListAccountsResult;
        setAccounts(data.accounts);
        setTotal(data.total);
        setIsSuperAdmin(data.isSuperAdmin);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setAccounts([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, roleFilter, activeFilter, offset, refreshTick]);

  // ── banner auto-dismiss ───────────────────────────────────────────
  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const applyAccount = useCallback((updated: AccountDto) => {
    setAccounts((prev) =>
      prev.map((a) => (a.userId === updated.userId ? updated : a)),
    );
  }, []);

  const markPending = useCallback((userId: string, on: boolean) => {
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  // ── handlers ──────────────────────────────────────────────────────
  const handleRoleChange = useCallback(
    async (account: AccountDto, newAdminRole: AdminUsersRole) => {
      if (!isSuperAdmin) return;
      if (account.adminRole === newAdminRole) return;
      const prevRole = account.adminRole;

      applyAccount({ ...account, adminRole: newAdminRole });
      markPending(account.userId, true);

      try {
        const res = await fetch(
          "/api/admin/accounts/" + encodeURIComponent(account.userId),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ admin_role: newAdminRole }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to update role");
        }
        applyAccount(json.data.account as AccountDto);
        t.success("update");
      } catch (err) {
        applyAccount({ ...account, adminRole: prevRole });
        console.error(err);
        t.error("update");
      } finally {
        markPending(account.userId, false);
      }
    },
    [applyAccount, isSuperAdmin, markPending, t],
  );

  const handleActiveChange = useCallback(
    async (account: AccountDto, newIsActive: boolean) => {
      if (!isSuperAdmin) return;
      if (account.isActive === newIsActive) return;
      const prev = account.isActive;

      applyAccount({ ...account, isActive: newIsActive });
      markPending(account.userId, true);

      try {
        const res = await fetch(
          "/api/admin/accounts/" + encodeURIComponent(account.userId),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_active: newIsActive }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to update active status");
        }
        applyAccount(json.data.account as AccountDto);
        t.success("update");
      } catch (err) {
        applyAccount({ ...account, isActive: prev });
        console.error(err);
        t.error("update");
      } finally {
        markPending(account.userId, false);
      }
    },
    [applyAccount, isSuperAdmin, markPending, t],
  );

  const handleOrgChange = useCallback(
    async (account: AccountDto, newOrgSlug: string | null) => {
      if (!isSuperAdmin) return;
      const current = account.organizationSlug ?? null;
      if (current === newOrgSlug) return;

      applyAccount({ ...account, organizationSlug: newOrgSlug });
      markPending(account.userId, true);

      try {
        const res = await fetch(
          "/api/admin/accounts/" + encodeURIComponent(account.userId),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organization_slug: newOrgSlug }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to update organization");
        }
        applyAccount(json.data.account as AccountDto);
        t.success("update");
      } catch (err) {
        applyAccount({ ...account, organizationSlug: current });
        console.error(err);
        t.error("update");
      } finally {
        markPending(account.userId, false);
      }
    },
    [applyAccount, isSuperAdmin, markPending, t],
  );

  const startNameEdit = useCallback((account: AccountDto) => {
    setEditingUserId(account.userId);
    setEditingName(account.displayName ?? "");
  }, []);

  const cancelNameEdit = useCallback(() => {
    setEditingUserId(null);
    setEditingName("");
  }, []);

  const handleNameSave = useCallback(
    async (account: AccountDto) => {
      if (!isSuperAdmin) return;
      const trimmed = editingName.trim();
      if (trimmed.length === 0) {
        setBanner({ kind: "error", message: "이름을 입력해주세요." });
        return;
      }
      if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
        setBanner({
          kind: "error",
          message: `이름은 ${DISPLAY_NAME_MAX_LENGTH}자 이하여야 합니다.`,
        });
        return;
      }
      if (trimmed === (account.displayName ?? "")) {
        cancelNameEdit();
        return;
      }

      markPending(account.userId, true);
      try {
        const res = await fetch(
          "/api/admin/accounts/" + encodeURIComponent(account.userId),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: trimmed }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to update display name");
        }
        applyAccount(json.data.account as AccountDto);
        cancelNameEdit();
        t.success("update");
      } catch (err) {
        console.error(err);
        t.error("update");
      } finally {
        markPending(account.userId, false);
      }
    },
    [applyAccount, cancelNameEdit, editingName, isSuperAdmin, markPending, t],
  );

  const handleResetPassword = useCallback(
    async (account: AccountDto) => {
      if (!isSuperAdmin) return;
      const confirmed = await confirm({
        title: "비밀번호 재설정",
        description:
          (account.displayName ?? account.email ?? account.userId) +
          " 의 비밀번호를 새 임시 비밀번호로 재설정합니다.\n\n계속하시겠습니까?",
        confirmLabel: "재설정",
        tone: "destructive",
      });
      if (!confirmed) return;

      markPending(account.userId, true);
      try {
        const res = await fetch(
          "/api/admin/accounts/" +
            encodeURIComponent(account.userId) +
            "/password-reset",
          { method: "POST" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to reset password");
        }
        setTempPassword({
          label: account.displayName ?? account.email ?? account.userId,
          email: account.email ?? account.authEmail ?? "—",
          password: json.data.temporary_password as string,
        });
      } catch (err) {
        console.error(err);
        t.error("reset");
      } finally {
        markPending(account.userId, false);
      }
    },
    [confirm, isSuperAdmin, markPending, t],
  );

  // ── derived ───────────────────────────────────────────────────────
  const pageEnd = offset + accounts.length;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">어드민 계정</h2>
          <p className="text-sm text-muted-foreground">
            어드민 페이지에 로그인할 수 있는 운영 계정을 관리합니다. 일반 프론트 회원은 표시되지 않습니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminHelp />
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            새로고침
          </Button>
          <Button
            disabled={!isSuperAdmin || loading}
            onClick={() => setCreateOpen(true)}
          >
            <UserPlus className="h-4 w-4" />새 운영 계정
          </Button>
        </div>
      </div>

      {!loading && !isSuperAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          🔒 조회 전용 — 운영 계정 생성·변경·비밀번호 재설정은 최고 관리자만 가능합니다.
        </div>
      )}

      {banner && (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700",
          )}
        >
          {banner.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            운영 계정 목록
            <AdminHelpIconButton
              helpKey="admin.settings.accounts.section.list"
              title="운영 계정 목록"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            {loading
              ? "불러오는 중..."
              : `총 ${total.toLocaleString()}명${
                  pageEnd > 0 ? ` (${offset + 1}-${pageEnd} 표시)` : ""
                }`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_160px]">
            <div className="flex items-center gap-1">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="이메일, user_id 로 검색"
                  className="pl-9"
                />
              </div>
              <AdminHelpIconButton
                helpKey="admin.settings.accounts.filter.search"
                title="검색"
                size="xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <div className="flex-1">
                <Select
                  value={roleFilter}
                  onValueChange={(v: string | null) => {
                    setRoleFilter(v ?? ROLE_ALL);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="역할 필터" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROLE_ALL}>전체 역할</SelectItem>
                    {ADMIN_USERS_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ADMIN_USERS_ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <AdminHelpIconButton
                helpKey="admin.settings.accounts.filter.role"
                title="역할 필터"
                size="xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <div className="flex-1">
                <Select
                  value={activeFilter}
                  onValueChange={(v: string | null) => {
                    setActiveFilter(v ?? ACTIVE_ALL);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="상태 필터" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ACTIVE_ALL}>전체 상태</SelectItem>
                    <SelectItem value="true">활성</SelectItem>
                    <SelectItem value="false">비활성</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <AdminHelpIconButton
                helpKey="admin.settings.accounts.filter.active"
                title="상태 필터"
                size="xs"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card border-r min-w-[220px]">
                    <span className="inline-flex items-center gap-1">
                      <span>이름</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.name"
                        title="이름"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[220px]">
                    <span className="inline-flex items-center gap-1">
                      <span>이메일</span>
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.loginEmail}
                        title="이메일"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[140px]">
                    <span className="inline-flex items-center gap-1">
                      <span>클럽</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.organization"
                        title="클럽"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[160px]">
                    <span className="inline-flex items-center gap-1">
                      <span>역할</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.role"
                        title="역할"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[140px]">
                    <span className="inline-flex items-center gap-1">
                      <span>상태</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.status"
                        title="상태"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>생성일</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.createdAt"
                        title="생성일"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>액션</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.accounts.column.action"
                        title="액션"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const isPending = pendingUserIds.has(account.userId);
                  return (
                    <TableRow key={account.userId}>
                      <TableCell className="sticky left-0 z-10 bg-card border-r max-w-[240px]">
                        {editingUserId === account.userId ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              maxLength={DISPLAY_NAME_MAX_LENGTH}
                              autoFocus
                              disabled={isPending}
                              aria-label="이름 수정 입력"
                              className="h-8 text-sm"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void handleNameSave(account);
                                } else if (e.key === "Escape") {
                                  cancelNameEdit();
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2"
                              loading={isPending}
                              onClick={() => void handleNameSave(account)}
                              title="저장"
                              aria-label="이름 저장"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2"
                              disabled={isPending}
                              onClick={cancelNameEdit}
                              title="취소"
                              aria-label="이름 수정 취소"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <div className="truncate font-medium">
                              {fmt(account.displayName)}
                            </div>
                            {isSuperAdmin && (
                              <button
                                type="button"
                                onClick={() => startNameEdit(account)}
                                disabled={isPending}
                                title="이름 수정"
                                aria-label="이름 수정"
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )}
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {account.userId}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate">
                        {fmt(account.email ?? account.authEmail)}
                      </TableCell>
                      <TableCell>
                        {isSuperAdmin ? (
                          <Select
                            value={account.organizationSlug ?? ORG_NONE}
                            onValueChange={(v: string | null) => {
                              const next =
                                v === null || v === ORG_NONE ? null : v;
                              void handleOrgChange(account, next);
                            }}
                          >
                            <SelectTrigger
                              className="h-8 w-[130px] text-xs"
                              disabled={isPending}
                            >
                              <SelectValue>
                                {orgLabel(account.organizationSlug)}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ORG_NONE}>
                                {ORGANIZATION_COMMON_LABEL}
                              </SelectItem>
                              {ORGANIZATIONS.map((slug) => (
                                <SelectItem key={slug} value={slug}>
                                  {ORGANIZATION_LABEL[slug]}
                                </SelectItem>
                              ))}
                              {account.organizationSlug &&
                                !isOrganizationSlug(
                                  account.organizationSlug,
                                ) && (
                                  <SelectItem
                                    value={account.organizationSlug}
                                    disabled
                                  >
                                    {account.organizationSlug} (목록 외)
                                  </SelectItem>
                                )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span>{orgLabel(account.organizationSlug)}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isSuperAdmin ? (
                          <Select
                            value={account.adminRole}
                            onValueChange={(v: string | null) => {
                              if (
                                v &&
                                (ADMIN_USERS_ROLES as readonly string[]).includes(v)
                              ) {
                                void handleRoleChange(
                                  account,
                                  v as AdminUsersRole,
                                );
                              }
                            }}
                          >
                            <SelectTrigger
                              className="h-8 w-[150px] text-xs"
                              disabled={isPending}
                            >
                              <SelectValue>
                                {ADMIN_USERS_ROLE_LABELS[account.adminRole]}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {ADMIN_USERS_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ADMIN_USERS_ROLE_LABELS[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                              ROLE_BADGE_CLASS[account.adminRole],
                            )}
                          >
                            {ADMIN_USERS_ROLE_LABELS[account.adminRole]}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isSuperAdmin ? (
                          <Select
                            value={account.isActive ? "true" : "false"}
                            onValueChange={(v: string | null) => {
                              if (v === "true" || v === "false") {
                                void handleActiveChange(account, v === "true");
                              }
                            }}
                          >
                            <SelectTrigger
                              className="h-8 w-[120px] text-xs"
                              disabled={isPending}
                            >
                              <SelectValue>
                                {account.isActive ? "활성" : "비활성"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">활성</SelectItem>
                              <SelectItem value="false">비활성</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                              account.isActive
                                ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
                                : "bg-red-100 text-red-800 ring-red-200",
                            )}
                          >
                            {account.isActive ? "활성" : "비활성"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(account.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={isPending}
                          disabled={!isSuperAdmin}
                          onClick={() => void handleResetPassword(account)}
                          title="비밀번호 재설정"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          비밀번호
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && accounts.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 운영 계정이 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && accounts.length === 0 && (
                  <TableSkeletonRows columns={7} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {total === 0 ? "0건" : `${offset + 1}-${pageEnd} / ${total}건`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                이전
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || loading}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                다음
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <CreateAccountDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false);
          reload();
          if (result.temporary_password) {
            setTempPassword({
              label: result.account.displayName ?? "(이름 없음)",
              email: result.account.email ?? result.account.authEmail ?? "—",
              password: result.temporary_password,
            });
          } else {
            t.success("create", "초대 메일을 발송했습니다.");
          }
        }}
      />

      <TempPasswordModal
        key={tempPassword?.password ?? "none"}
        data={tempPassword}
        onClose={() => setTempPassword(null)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Create drawer — admin_role 3개 선택 (owner/admin/viewer)
// ─────────────────────────────────────────────────────────────────────
function CreateAccountDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreateAccountResult) => void;
}) {
  if (!open) return null;
  return <CreateAccountDrawerInner onClose={onClose} onCreated={onCreated} />;
}

function CreateAccountDrawerInner({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreateAccountResult) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState<string>(ORG_NONE);
  const [adminRole, setAdminRole] = useState<AdminUsersRole>("admin");
  const [isActive, setIsActive] = useState(true);
  const [sendInviteEmail, setSendInviteEmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          email,
          organization_slug:
            organizationSlug === ORG_NONE ? null : organizationSlug,
          admin_role: adminRole,
          is_active: isActive,
          send_invite_email: sendInviteEmail,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to create account");
      }
      onCreated(json.data as CreateAccountResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="새 운영 계정 만들기"
      className="fixed inset-0 z-50 flex"
    >
      {/* 배경 클릭/드래그로는 닫히지 않는다. 닫기는 X·취소·저장 버튼 또는 Esc 로만. */}
      <div className="absolute inset-0 bg-foreground/40" />
      <div className="relative ml-auto flex h-full modal-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <h3 className="inline-flex items-center gap-1.5 text-base font-semibold">
            새 운영 계정 만들기
            <AdminHelpIconButton
              helpKey="admin.settings.accounts.section.createAccount"
              title="새 운영 계정 만들기"
              size="sm"
            />
          </h3>
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

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="create-name"
                className="inline-flex items-center gap-1"
              >
                이름
                <AdminHelpIconButton
                  helpKey="admin.settings.accounts.field.name"
                  title="이름"
                  size="xs"
                />
              </Label>
              <Input
                id="create-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="예: 홍길동"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="create-email"
                className="inline-flex items-center gap-1"
              >
                이메일
                <AdminHelpIconButton
                  helpKey={ADMIN_SHARED_HELP_KEYS.crew.loginEmail}
                  title="이메일"
                  size="xs"
                />
              </Label>
              <Input
                id="create-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="hong@example.com"
                required
              />
              <p className="text-xs text-muted-foreground">
                어드민 로그인용 이메일. 이미 등록된 이메일은 사용할 수 없습니다.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="create-org"
                className="inline-flex items-center gap-1"
              >
                클럽
                <AdminHelpIconButton
                  helpKey="admin.settings.accounts.field.organization"
                  title="클럽"
                  size="xs"
                />
              </Label>
              <Select
                value={organizationSlug}
                onValueChange={(v: string | null) =>
                  setOrganizationSlug(v ?? ORG_NONE)
                }
              >
                <SelectTrigger id="create-org">
                  <SelectValue>
                    {organizationSlug === ORG_NONE
                      ? ORGANIZATION_COMMON_LABEL
                      : ORGANIZATION_LABEL[
                          organizationSlug as (typeof ORGANIZATIONS)[number]
                        ] ?? organizationSlug}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_NONE}>
                    {ORGANIZATION_COMMON_LABEL}
                  </SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {ORGANIZATION_LABEL[slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ORGANIZATION_COMMON_LABEL} 을 선택하면 특정 클럽에 속하지 않는 공용 계정으로 저장합니다 (클럽 횡단).
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="create-role"
                className="inline-flex items-center gap-1"
              >
                역할
                <AdminHelpIconButton
                  helpKey="admin.settings.accounts.field.role"
                  title="역할"
                  size="xs"
                />
              </Label>
              <Select
                value={adminRole}
                onValueChange={(v: string | null) => {
                  if (
                    v &&
                    (ADMIN_USERS_ROLES as readonly string[]).includes(v)
                  ) {
                    setAdminRole(v as AdminUsersRole);
                  }
                }}
              >
                <SelectTrigger id="create-role">
                  <SelectValue>{ADMIN_USERS_ROLE_LABELS[adminRole]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ADMIN_USERS_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ADMIN_USERS_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {adminRole === "owner" && (
                <p className="text-xs text-amber-700">
                  ⚠ 최고 관리자는 권한 매트릭스 변경, 다른 운영 계정 생성/변경 등 모든 권한을 가집니다.
                </p>
              )}
              {adminRole === "viewer" && (
                <p className="text-xs text-muted-foreground">
                  조회자는 어드민 페이지의 조회만 가능합니다.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="inline-flex items-center gap-1">
                상태
                <AdminHelpIconButton
                  helpKey="admin.settings.accounts.field.status"
                  title="상태"
                  size="xs"
                />
              </Label>
              <Select
                value={isActive ? "true" : "false"}
                onValueChange={(v: string | null) => {
                  if (v === "true" || v === "false") setIsActive(v === "true");
                }}
              >
                <SelectTrigger>
                  <SelectValue>{isActive ? "활성" : "비활성"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">활성</SelectItem>
                  <SelectItem value="false">비활성</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-3">
              <div className="flex justify-end">
                <AdminHelpIconButton
                  helpKey="admin.settings.accounts.field.issueMethod"
                  title="발급 방식"
                  size="xs"
                />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!sendInviteEmail}
                  onChange={(e) => setSendInviteEmail(!e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">임시 비밀번호 즉시 발급</span>
                  <span className="block text-xs text-muted-foreground">
                    생성 직후 1회만 표시되며, 사용자에게 안전한 채널로 직접 전달합니다.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sendInviteEmail}
                  onChange={(e) => setSendInviteEmail(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">초대 메일 발송</span>
                  <span className="block text-xs text-muted-foreground">
                    Supabase 가 초대 링크를 메일로 보냅니다. SMTP 미구성 환경에선 실패할 수 있습니다.
                  </span>
                </span>
              </label>
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" loading={saving}>
              운영 계정 생성
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Temporary password modal — 새 password 가 들어올 때마다 key 로 remount.
// ─────────────────────────────────────────────────────────────────────
function TempPasswordModal({
  data,
  onClose,
}: {
  data: { label: string; email: string; password: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);

  if (!data) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data.password);
      setCopied(true);
    } catch {
      if (inputRef.current) {
        inputRef.current.select();
        document.execCommand("copy");
        setCopied(true);
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="임시 비밀번호"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div className="absolute inset-0 bg-foreground/40" />
      <div className="relative modal-w-md rounded-lg border bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <h3 className="text-base font-semibold">임시 비밀번호 발급됨</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">이 비밀번호는 한 번만 표시됩니다.</span>{" "}
            복사 후 사용자에게 안전한 채널(대면, 1:1 메신저 등)로 전달하세요.
          </p>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <div className="text-xs text-muted-foreground">대상</div>
            <div className="text-sm font-medium">{data.label}</div>
            <div className="text-xs text-muted-foreground">{data.email}</div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              readOnly
              value={data.password}
              className="font-mono text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={handleCopy}>
              <Copy className="h-4 w-4" />
              {copied ? "복사됨" : "복사"}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-amber-700">
            ⚠ 첫 로그인 후 사용자 본인이 비밀번호를 변경하도록 안내하세요.
          </p>
        </div>
        <footer className="flex items-center justify-end border-t bg-muted/30 px-5 py-3">
          <Button type="button" onClick={onClose}>
            확인
          </Button>
        </footer>
      </div>
    </div>
  );
}
