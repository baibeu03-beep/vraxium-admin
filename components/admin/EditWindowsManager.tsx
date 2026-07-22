"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { RefreshCw, Search, X } from "lucide-react";
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
import { Checkbox, checkedTextClass, checkedRowClass } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { organizationLabelKo } from "@/lib/organizations";
import {
  DEFAULT_RESOURCE_KEY,
  EDITABLE_RESOURCES,
  QUICK_ACTIONS,
  computeEditWindowStatus,
  computeQuickActionRange,
  getResourceDescription,
  getResourceLabel,
  isEditableResourceKey,
  isWeekScopedResourceKey,
  statusLabel,
  type EditWindowDto,
  type EditWindowStatus,
  type EditWindowUserRow,
  type QuickActionKey,
  type WeekOption,
} from "@/lib/adminEditWindowsTypes";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { formatClubDateTime } from "@/lib/clubDate";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { useActionToast } from "@/lib/actionToast";

const PAGE_SIZE = 50;
const RESOURCE_OPTIONS = [...EDITABLE_RESOURCES].sort((a, b) => a.order - b.order);

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "-";
}

// updatedAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "-" });
}

// 조직 표시명 = lib/organizations 단일 SoT. 이 화면은 미지정을 "-" 로 표기한다.
function orgLabel(slug: string | null) {
  return organizationLabelKo(slug, { nullLabel: "-" });
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function fromLocalInputValue(value: string): Date {
  return new Date(value);
}

function statusBadgeClass(status: EditWindowStatus): string {
  switch (status) {
    case "open":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "closed":
      return "border-border bg-muted text-muted-foreground";
    case "expired":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "none":
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

export default function EditWindowsManager() {
  const searchParams = useSearchParams();
  const devMode = useAdminDevMode();

  const initialQuery = useMemo(
    () => searchParams.get("q")?.trim() ?? "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const initialResourceKey = useMemo(() => {
    const raw = searchParams.get("resource")?.trim() ?? "";
    return isEditableResourceKey(raw) ? raw : DEFAULT_RESOURCE_KEY;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [resourceKey, setResourceKey] = useState<string>(initialResourceKey);
  const weekScoped = isWeekScopedResourceKey(resourceKey);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string | null>(null);
  const selectedWeek = useMemo(
    () => weekOptions.find((w) => w.weekId === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );
  // 주간 자원인데 주차가 아직 선택되지 않은 상태 — 권한 열기/닫기를 막는다.
  const weekBlocked = weekScoped && !selectedWeekId;
  // 실제 payload 에 실릴 week_id. 비주간 자원이면 항상 null.
  const effectiveWeekId = weekScoped ? selectedWeekId : null;
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [rows, setRows] = useState<EditWindowUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const t = useActionToast();
  const [editing, setEditing] = useState<EditWindowUserRow | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQuery((prev) => {
        const next = query.trim();
        if (prev !== next) {
          setOffset(0);
          setSelectedUserIds(new Set());
          setAllMatchingSelected(false);
        }
        return next;
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  // 주차 선택 드롭다운 옵션 (weeks ⨝ season_definitions) — 1회 로드.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/edit-windows/weeks", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!cancelled && res.ok && json.success) {
          setWeekOptions((json.data?.weeks ?? []) as WeekOption[]);
        }
      } catch {
        // 주차 목록 로드 실패는 치명적이지 않다 — 셀렉트가 비어 있을 뿐.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 주간 자원으로 전환했고 아직 주차가 없으면 가장 최근 주차를 기본 선택한다.
  useEffect(() => {
    if (weekScoped && !selectedWeekId && weekOptions.length > 0) {
      setSelectedWeekId(weekOptions[0].weekId);
    }
  }, [weekScoped, selectedWeekId, weekOptions]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set("resource_key", resourceKey);
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (weekScoped && selectedWeekId) params.set("week_id", selectedWeekId);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (readScopeMode(searchParams) === "test") params.set("mode", "test"); // QA 누수 차단
      try {
        const res = await fetch("/api/admin/edit-windows?" + params.toString(), {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load edit windows.");
        }
        if (!cancelled) {
          setRows((json.data?.rows ?? []) as EditWindowUserRow[]);
          setTotal(Number(json.data?.total ?? 0));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setRows([]);
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
  }, [resourceKey, debouncedQuery, offset, refreshTick, weekScoped, selectedWeekId]);

  const reload = () => setRefreshTick((n) => n + 1);

  const selectedCount = allMatchingSelected ? total : selectedUserIds.size;
  const pageAllSelected =
    allMatchingSelected ||
    (rows.length > 0 && rows.every((row) => selectedUserIds.has(row.userId)));

  const clearSelection = useCallback(() => {
    setSelectedUserIds(new Set());
    setAllMatchingSelected(false);
  }, []);

  const handleTogglePage = useCallback(
    (checked: boolean) => {
      setAllMatchingSelected(false);
      setSelectedUserIds((prev) => {
        const next = new Set(prev);
        for (const row of rows) {
          if (checked) next.add(row.userId);
          else next.delete(row.userId);
        }
        return next;
      });
    },
    [rows],
  );

  const handleToggleUser = useCallback((userId: string, checked: boolean) => {
    setAllMatchingSelected(false);
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  const handleBulkQuickAction = useCallback(
    async (action: QuickActionKey) => {
      const { openedAt, expiresAt } = computeQuickActionRange(action);
      await bulkWindow(
        {
          resource_key: resourceKey,
          opened_at: openedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          user_ids: Array.from(selectedUserIds),
          select_all_matching: allMatchingSelected,
          filters: { q: debouncedQuery },
        },
        effectiveWeekId,
      )
        .then(() => {
          clearSelection();
          reload();
          t.success("open", "권한을 부여했습니다.");
        })
        .catch((err: Error) => {
          console.error(err);
          t.error("open");
        });
    },
    [
      allMatchingSelected,
      clearSelection,
      debouncedQuery,
      devMode,
      resourceKey,
      selectedUserIds,
      effectiveWeekId,
      t,
    ],
  );

  const handleBulkClose = useCallback(async () => {
    await bulkWindow(
      {
        resource_key: resourceKey,
        action: "close",
        user_ids: Array.from(selectedUserIds),
        select_all_matching: allMatchingSelected,
        filters: { q: debouncedQuery },
      },
      effectiveWeekId,
    )
      .then(() => {
        clearSelection();
        reload();
        t.success("cancel", "권한을 닫았습니다.");
      })
      .catch((err: Error) => {
        console.error(err);
        t.error("cancel");
      });
  }, [
    allMatchingSelected,
    clearSelection,
    debouncedQuery,
    devMode,
    resourceKey,
    selectedUserIds,
    effectiveWeekId,
    t,
  ]);

  const applyWindowToRow = useCallback(
    (userId: string, window: EditWindowDto | null) => {
      setRows((prev) =>
        prev.map((row) => (row.userId === userId ? { ...row, window } : row)),
      );
      setEditing((prev) =>
        prev && prev.userId === userId ? { ...prev, window } : prev,
      );
    },
    [],
  );

  const handleQuickAction = useCallback(
    async (row: EditWindowUserRow, action: QuickActionKey) => {
      const { openedAt, expiresAt } = computeQuickActionRange(action);
      await patchWindow(
        row.userId,
        {
          resource_key: resourceKey,
          opened_at: openedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        },
        effectiveWeekId,
      )
        .then((win) => {
          applyWindowToRow(row.userId, win);
          reload();
          t.success("open", "권한을 열었습니다.");
        })
        .catch((err: Error) => {
          console.error(err);
          t.error("open");
        });
    },
    [applyWindowToRow, devMode, resourceKey, effectiveWeekId, t],
  );

  const handleClose = useCallback(
    async (row: EditWindowUserRow) => {
      await patchWindow(
        row.userId,
        {
          resource_key: resourceKey,
          action: "close",
        },
        effectiveWeekId,
      )
        .then((win) => {
          applyWindowToRow(row.userId, win);
          reload();
          t.success("cancel", "권한을 닫았습니다.");
        })
        .catch((err: Error) => {
          console.error(err);
          t.error("cancel");
        });
    },
    [applyWindowToRow, devMode, resourceKey, effectiveWeekId, t],
  );

  const pageEnd = offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  return (
    <div className="admin-section-stack-lg">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold tracking-tight">작성 기간 관리</h2>
          <p className="text-sm text-muted-foreground">
            {devMode
              ? "사용자별 / 리소스별 편집 가능 기간을 열고 닫습니다."
              : "회원별로 어떤 작성을 언제까지 할 수 있는지 관리합니다."}
            {devMode && (
              <>
                {" "}기준 테이블:{" "}
                <code className="mx-1 font-mono">public.user_edit_windows</code>
              </>
            )}
          </p>
        </div>
        <AdminHelp />
        <Button variant="outline" onClick={reload} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {devMode ? "사용자 & 리소스" : "회원 & 작성 항목"}
          </CardTitle>
          <CardDescription>
            {devMode
              ? "리소스를 선택하고 사용자를 검색한 뒤, 빠른 액션이나 직접 기간 설정으로 권한을 부여하세요."
              : "작성 항목을 고른 뒤 회원을 검색해, 빠른 열기 또는 직접 기간 설정으로 권한을 부여하세요."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex flex-col gap-1.5 sm:w-[260px]">
              <Label htmlFor="resource-key" className="inline-flex items-center gap-1">
                {devMode ? "리소스" : "작성 항목"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.filter.resource"
                  title="작성 항목"
                  size="xs"
                />
              </Label>
              <Select
                value={resourceKey}
                onValueChange={(value: string | null) => {
                  setResourceKey(value ?? DEFAULT_RESOURCE_KEY);
                  setOffset(0);
                  clearSelection();
                }}
              >
                <SelectTrigger id="resource-key">
                  <SelectValue>{getResourceLabel(resourceKey, devMode)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {RESOURCE_OPTIONS.map((resource) => (
                    <SelectItem key={resource.key} value={resource.key}>
                      {devMode ? resource.devLabel : resource.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {getResourceDescription(resourceKey, devMode)}
              </p>
            </div>
            {weekScoped && (
              <div className="flex flex-col gap-1.5 sm:w-[260px]">
                <Label htmlFor="week-select" className="inline-flex items-center gap-1">
                  {devMode ? "주차 (week_id)" : "주차"}
                  <AdminHelpIconButton
                    helpKey="admin.settings.editWindows.filter.week"
                    title="주차"
                    size="xs"
                  />
                </Label>
                <Select
                  value={selectedWeekId ?? ""}
                  onValueChange={(value: string | null) => {
                    setSelectedWeekId(value ?? null);
                    setOffset(0);
                    clearSelection();
                  }}
                >
                  <SelectTrigger id="week-select">
                    <SelectValue placeholder={devMode ? "주차 선택" : "주차를 선택하세요"}>
                      {selectedWeek?.label ?? (devMode ? "주차 선택" : "주차를 선택하세요")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {weekOptions.length === 0 ? (
                      <SelectItem value="__none__" disabled>
                        주차 데이터 없음
                      </SelectItem>
                    ) : (
                      weekOptions.map((week) => (
                        <SelectItem key={week.weekId} value={week.weekId}>
                          {week.label}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {devMode
                    ? "주간 자원 권한은 선택한 주차에만 적용됩니다."
                    : "이 작성 항목 권한은 선택한 주차에만 적용됩니다."}
                </p>
              </div>
            )}
            <div className="flex flex-col gap-1.5 sm:flex-1">
              <Label htmlFor="user-search" className="inline-flex items-center gap-1">
                {devMode ? "사용자 검색" : "회원 검색"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.filter.search"
                  title="회원 검색"
                  size="xs"
                />
              </Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="user-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    devMode
                      ? "display_name, auth_email, contact_email, organization, user_id"
                      : "이름, 이메일, 소속, user_id로 검색"
                  }
                  className="pl-9"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {weekScoped &&
            (weekBlocked ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {devMode
                  ? "주간 자원입니다. 권한을 열기 전에 위에서 주차(week_id)를 먼저 선택하세요."
                  : "주차별 작성 항목입니다. 권한을 부여하려면 위에서 주차를 먼저 선택하세요."}
              </div>
            ) : (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
                현재 선택된 주차: <strong>{selectedWeek?.label ?? selectedWeekId}</strong>
                {" — "}이 주차에만 권한이 적용됩니다.
              </div>
            ))}

          <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-2">
                <Checkbox
                  checked={pageAllSelected}
                  onChange={(e) => handleTogglePage(e.target.checked)}
                  aria-label="현재 페이지 전체 선택"
                />
                <span className={cn(checkedTextClass(pageAllSelected))}>현재 페이지 전체 선택</span>
              </label>
              <button
                type="button"
                className="rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => {
                  setSelectedUserIds(new Set(rows.map((row) => row.userId)));
                  setAllMatchingSelected(true);
                }}
                disabled={total === 0}
              >
                현재 필터 결과 전체 선택
              </button>
              <span className="text-muted-foreground">
                선택됨: {selectedCount.toLocaleString()}명
              </span>
              {selectedCount > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  onClick={clearSelection}
                >
                  선택 해제
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0 || weekBlocked}
                onClick={() => void handleBulkQuickAction("open_24h")}
              >
                24시간 열기
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0 || weekBlocked}
                onClick={() => void handleBulkQuickAction("open_7d")}
              >
                7일 열기
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0 || weekBlocked}
                onClick={() => setBulkEditing(true)}
              >
                직접 기간 설정
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0 || weekBlocked}
                onClick={() => void handleBulkClose()}
              >
                선택 기간 닫기
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card w-10">
                    <span className="sr-only">선택</span>
                  </TableHead>
                  <TableHead className="sticky left-10 z-20 bg-card border-r">
                    <span className="inline-flex items-center gap-1">
                      <span>{devMode ? "이름 / user_id" : "이름"}</span>
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.name}
                        title="이름"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>{devMode ? "auth_email" : "로그인 이메일"}</span>
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.loginEmail}
                        title="로그인 이메일"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>소속</span>
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.organization}
                        title="소속"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>상태</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.editWindows.column.status"
                        title="작성 상태"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>기간</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.editWindows.column.period"
                        title="작성 기간"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="w-[320px]">
                    <span className="inline-flex items-center gap-1">
                      <span>액션</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.editWindows.column.action"
                        title="액션"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>수정자</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.editWindows.column.editor"
                        title="수정자"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>수정일시</span>
                      <AdminHelpIconButton
                        helpKey="admin.settings.editWindows.column.updatedAt"
                        title="수정일시"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = computeEditWindowStatus(row.window);
                  const rowChecked =
                    allMatchingSelected || selectedUserIds.has(row.userId);
                  return (
                    <TableRow key={row.userId} className={cn(checkedRowClass(rowChecked))}>
                      <TableCell className="sticky left-0 z-10 bg-card w-10">
                        <Checkbox
                          checked={rowChecked}
                          onChange={(e) =>
                            handleToggleUser(row.userId, e.target.checked)
                          }
                          aria-label={(row.displayName ?? row.userId) + " 선택"}
                        />
                      </TableCell>
                      <TableCell className="sticky left-10 z-10 bg-card border-r max-w-[220px]">
                        <div className={cn("truncate font-medium", checkedTextClass(rowChecked))}>{fmt(row.displayName)}</div>
                        {devMode && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {row.userId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(row.authEmail)}
                      </TableCell>
                      <TableCell>{orgLabel(row.organizationSlug)}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
                            statusBadgeClass(status),
                          )}
                        >
                          {statusLabel(status)}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {row.window ? (
                          <div className="flex flex-col">
                            <span>
                              <span className="text-muted-foreground">시작</span>{" "}
                              {formatClubDateTime(row.window.openedAt)}
                            </span>
                            <span>
                              <span className="text-muted-foreground">종료</span>{" "}
                              {formatClubDateTime(row.window.expiresAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => void handleQuickAction(row, "open_24h")}
                            disabled={weekBlocked}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            24h
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleQuickAction(row, "open_7d")}
                            disabled={weekBlocked}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            7d
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleQuickAction(row, "open_until_midnight")
                            }
                            disabled={weekBlocked}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            자정
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleClose(row)}
                            disabled={status !== "open" || weekBlocked}
                            className={cn(
                              "rounded-md border px-2 py-1 text-xs",
                              status === "open" && !weekBlocked
                                ? "hover:bg-muted"
                                : "cursor-not-allowed text-muted-foreground",
                            )}
                          >
                            닫기
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            disabled={weekBlocked}
                            className="rounded-md border bg-foreground px-2 py-1 text-xs text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            기간 설정
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs">
                        {row.window ? (
                          fmt(row.window.grantedByEmail ?? row.window.grantedBy)
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {row.window?.updatedAt ? (
                          fmtDate(row.window.updatedAt)
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && rows.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 사용자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && rows.length === 0 && (
                  <TableSkeletonRows columns={9} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {total === 0
                ? "0건"
                : String(offset + 1) +
                  "-" +
                  String(pageEnd) +
                  " / " +
                  String(total) +
                  "건"}
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

      <EditWindowDrawer
        row={editing}
        resourceKey={resourceKey}
        weekId={effectiveWeekId}
        weekLabel={selectedWeek?.label ?? null}
        devMode={devMode}
        onClose={() => setEditing(null)}
        onSaved={(userId, window) => {
          applyWindowToRow(userId, window);
          reload();
          setEditing(null);
          t.success("save", "작성 기간이 저장되었습니다.");
        }}
      />
      <BulkEditWindowDrawer
        open={bulkEditing}
        resourceKey={resourceKey}
        weekId={effectiveWeekId}
        weekLabel={selectedWeek?.label ?? null}
        selectedCount={selectedCount}
        devMode={devMode}
        onClose={() => setBulkEditing(false)}
        onSaved={() => {
          setBulkEditing(false);
          clearSelection();
          reload();
          t.success("save", "작성 기간이 저장되었습니다.");
        }}
        getPayloadBase={() => ({
          user_ids: Array.from(selectedUserIds),
          select_all_matching: allMatchingSelected,
          filters: { q: debouncedQuery },
        })}
      />
    </div>
  );
}

type UpsertBody = {
  resource_key: string;
  opened_at: string;
  expires_at: string;
  note?: string | null;
};

type CloseBody = { resource_key: string; action: "close" };

async function patchWindow(
  userId: string,
  body: UpsertBody | CloseBody,
  weekId: string | null = null,
): Promise<EditWindowDto | null> {
  const res = await fetch(
    appendModeQuery(
      "/api/admin/edit-windows/" + encodeURIComponent(userId),
      readScopeMode(new URLSearchParams(window.location.search)), // QA 쓰기 스코프 전파
    ),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, week_id: weekId }),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json?.error ?? "Failed to save");
  }
  return (json.data?.window ?? null) as EditWindowDto | null;
}

type BulkPayloadBase = {
  user_ids: string[];
  select_all_matching: boolean;
  filters: { q: string };
};

type BulkUpsertBody = UpsertBody & BulkPayloadBase;
type BulkCloseBody = CloseBody & BulkPayloadBase;

async function bulkWindow(
  body: BulkUpsertBody | BulkCloseBody,
  weekId: string | null = null,
): Promise<number> {
  const res = await fetch(
    appendModeQuery(
      "/api/admin/edit-windows/bulk",
      readScopeMode(new URLSearchParams(window.location.search)), // QA 쓰기 스코프 전파
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, week_id: weekId }),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json?.error ?? "Failed to save selected users");
  }
  return Number(json.data?.count ?? 0);
}

function EditWindowDrawer({
  row,
  resourceKey,
  weekId,
  weekLabel,
  devMode,
  onClose,
  onSaved,
}: {
  row: EditWindowUserRow | null;
  resourceKey: string;
  weekId: string | null;
  weekLabel: string | null;
  devMode: boolean;
  onClose: () => void;
  onSaved: (userId: string, window: EditWindowDto | null) => void;
}) {
  if (!row) return null;
  return (
    <EditWindowDrawerInner
      key={row.userId + ":" + resourceKey + ":" + (weekId ?? "")}
      row={row}
      resourceKey={resourceKey}
      weekId={weekId}
      weekLabel={weekLabel}
      devMode={devMode}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function EditWindowDrawerInner({
  row,
  resourceKey,
  weekId,
  weekLabel,
  devMode,
  onClose,
  onSaved,
}: {
  row: EditWindowUserRow;
  resourceKey: string;
  weekId: string | null;
  weekLabel: string | null;
  devMode: boolean;
  onClose: () => void;
  onSaved: (userId: string, window: EditWindowDto | null) => void;
}) {
  const initial = useMemo(() => {
    const window = row.window;
    if (window) {
      return {
        opened: toLocalInputValue(new Date(window.openedAt)),
        expires: toLocalInputValue(new Date(window.expiresAt)),
        note: window.note ?? "",
      };
    }
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      opened: toLocalInputValue(now),
      expires: toLocalInputValue(later),
      note: "",
    };
  }, [row]);

  const [opened, setOpened] = useState(initial.opened);
  const [expires, setExpires] = useState(initial.expires);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const handleQuick = (action: QuickActionKey) => {
    const { openedAt, expiresAt } = computeQuickActionRange(action);
    setOpened(toLocalInputValue(openedAt));
    setExpires(toLocalInputValue(expiresAt));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const openedDate = fromLocalInputValue(opened);
    const expiresDate = fromLocalInputValue(expires);
    if (
      Number.isNaN(openedDate.getTime()) ||
      Number.isNaN(expiresDate.getTime())
    ) {
      setError("올바른 날짜를 입력해주세요.");
      return;
    }
    if (expiresDate.getTime() <= openedDate.getTime()) {
      setError("종료 시각은 시작 시각보다 이후여야 합니다.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const window = await patchWindow(
        row.userId,
        {
          resource_key: resourceKey,
          opened_at: openedDate.toISOString(),
          expires_at: expiresDate.toISOString(),
          note: note.trim() ? note.trim() : null,
        },
        weekId,
      );
      onSaved(row.userId, window);
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
      aria-label="작성기간 설정"
      className="fixed inset-0 z-50 flex"
    >
      {/* 배경 클릭/드래그로는 닫히지 않는다. 닫기는 X·취소·저장 버튼 또는 Esc 로만. */}
      <div className="absolute inset-0 bg-foreground/40" />
      <div className="relative ml-auto flex h-full modal-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">작성기간 설정</h3>
            <p className="text-xs text-muted-foreground">
              {row.displayName ?? "(이름 없음)"}
              {devMode && (
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  {row.userId}
                </span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {devMode ? (
                <>
                  리소스 <code className="font-mono">{resourceKey}</code>
                </>
              ) : (
                <>작성 항목: {getResourceLabel(resourceKey, false)}</>
              )}
            </p>
            {weekLabel && (
              <p className="mt-0.5 text-xs font-medium text-emerald-700">
                주차: {weekLabel}
              </p>
            )}
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
            <div className="flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => handleQuick(action.key)}
                  className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {action.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-opened" className="inline-flex items-center gap-1">
                {devMode ? "시작 (opened_at)" : "시작 시각"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.openedAt"
                  title="시작 시각"
                  size="xs"
                />
              </Label>
              <Input
                id="window-opened"
                type="datetime-local"
                value={opened}
                onChange={(e) => setOpened(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-expires" className="inline-flex items-center gap-1">
                {devMode ? "종료 (expires_at)" : "종료 시각"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.expiresAt"
                  title="종료 시각"
                  size="xs"
                />
              </Label>
              <Input
                id="window-expires"
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-note" className="inline-flex items-center gap-1">
                {devMode ? "메모 (note)" : "메모"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.note"
                  title="메모"
                  size="xs"
                />
              </Label>
              <Input
                id="window-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 1차 작성 기간 연장"
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
            <Button type="submit" loading={saving}>
              저장
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function BulkEditWindowDrawer({
  open,
  resourceKey,
  weekId,
  weekLabel,
  selectedCount,
  devMode,
  onClose,
  onSaved,
  getPayloadBase,
}: {
  open: boolean;
  resourceKey: string;
  weekId: string | null;
  weekLabel: string | null;
  selectedCount: number;
  devMode: boolean;
  onClose: () => void;
  onSaved: (count: number) => void;
  getPayloadBase: () => BulkPayloadBase;
}) {
  if (!open) return null;
  return (
    <BulkEditWindowDrawerInner
      resourceKey={resourceKey}
      weekId={weekId}
      weekLabel={weekLabel}
      selectedCount={selectedCount}
      devMode={devMode}
      onClose={onClose}
      onSaved={onSaved}
      getPayloadBase={getPayloadBase}
    />
  );
}

function BulkEditWindowDrawerInner({
  resourceKey,
  weekId,
  weekLabel,
  selectedCount,
  devMode,
  onClose,
  onSaved,
  getPayloadBase,
}: {
  resourceKey: string;
  weekId: string | null;
  weekLabel: string | null;
  selectedCount: number;
  devMode: boolean;
  onClose: () => void;
  onSaved: (count: number) => void;
  getPayloadBase: () => BulkPayloadBase;
}) {
  const initial = useMemo(() => {
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      opened: toLocalInputValue(now),
      expires: toLocalInputValue(later),
      note: "",
    };
  }, []);

  const [opened, setOpened] = useState(initial.opened);
  const [expires, setExpires] = useState(initial.expires);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const handleQuick = (action: QuickActionKey) => {
    const { openedAt, expiresAt } = computeQuickActionRange(action);
    setOpened(toLocalInputValue(openedAt));
    setExpires(toLocalInputValue(expiresAt));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const openedDate = fromLocalInputValue(opened);
    const expiresDate = fromLocalInputValue(expires);
    if (
      Number.isNaN(openedDate.getTime()) ||
      Number.isNaN(expiresDate.getTime())
    ) {
      setError("올바른 날짜를 입력해주세요.");
      return;
    }
    if (expiresDate.getTime() <= openedDate.getTime()) {
      setError("종료 시각은 시작 시각보다 이후여야 합니다.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const count = await bulkWindow(
        {
          ...getPayloadBase(),
          resource_key: resourceKey,
          opened_at: openedDate.toISOString(),
          expires_at: expiresDate.toISOString(),
          note: note.trim() ? note.trim() : null,
        },
        weekId,
      );
      onSaved(count);
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
      aria-label="선택 기간 설정"
      className="fixed inset-0 z-50 flex"
    >
      {/* 배경 클릭/드래그로는 닫히지 않는다. 닫기는 X·취소·저장 버튼 또는 Esc 로만. */}
      <div className="absolute inset-0 bg-foreground/40" />
      <div className="relative ml-auto flex h-full modal-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">선택 기간 설정</h3>
            <p className="text-xs text-muted-foreground">
              선택된 {selectedCount.toLocaleString()}명
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {devMode ? (
                <>
                  리소스 <code className="font-mono">{resourceKey}</code>
                </>
              ) : (
                <>작성 항목: {getResourceLabel(resourceKey, false)}</>
              )}
            </p>
            {weekLabel && (
              <p className="mt-0.5 text-xs font-medium text-emerald-700">
                주차: {weekLabel}
              </p>
            )}
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
            <div className="flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => handleQuick(action.key)}
                  className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {action.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-opened" className="inline-flex items-center gap-1">
                {devMode ? "시작 (opened_at)" : "시작 시각"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.bulkOpenedAt"
                  title="시작 시각"
                  size="xs"
                />
              </Label>
              <Input
                id="bulk-window-opened"
                type="datetime-local"
                value={opened}
                onChange={(e) => setOpened(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-expires" className="inline-flex items-center gap-1">
                {devMode ? "종료 (expires_at)" : "종료 시각"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.bulkExpiresAt"
                  title="종료 시각"
                  size="xs"
                />
              </Label>
              <Input
                id="bulk-window-expires"
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-note" className="inline-flex items-center gap-1">
                {devMode ? "메모 (note)" : "메모"}
                <AdminHelpIconButton
                  helpKey="admin.settings.editWindows.field.bulkNote"
                  title="메모"
                  size="xs"
                />
              </Label>
              <Input
                id="bulk-window-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 일괄 작성 기간 부여"
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
            <Button type="submit" loading={saving} disabled={selectedCount === 0}>
              저장
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
