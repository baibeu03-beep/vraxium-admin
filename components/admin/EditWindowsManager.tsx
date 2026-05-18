"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import {
  DEFAULT_RESOURCE_KEY,
  EDITABLE_RESOURCES,
  QUICK_ACTIONS,
  computeEditWindowStatus,
  computeQuickActionRange,
  getResourceLabel,
  isEditableResourceKey,
  statusLabel,
  type EditWindowDto,
  type EditWindowStatus,
  type EditWindowUserRow,
  type QuickActionKey,
} from "@/lib/adminEditWindowsTypes";

const PAGE_SIZE = 50;

type Banner = { kind: "success" | "error"; message: string } | null;

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "—";
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function orgLabel(slug: string | null) {
  if (!slug) return "미지정";
  if (isOrganizationSlug(slug)) return ORGANIZATION_LABEL[slug];
  return slug;
}

// datetime-local input 은 로컬타임존 기준 "YYYY-MM-DDTHH:mm" 문자열을 다룬다.
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function fromLocalInputValue(value: string): Date {
  // new Date("YYYY-MM-DDTHH:mm") 은 로컬타임존으로 해석된다.
  return new Date(value);
}

function statusBadgeClass(status: EditWindowStatus): string {
  switch (status) {
    case "open":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "closed":
      return "border-slate-200 bg-slate-50 text-slate-600";
    case "expired":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "none":
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

export default function EditWindowsManager() {
  const searchParams = useSearchParams();

  // URL ?q= 와 ?resource= 를 초기 값으로 사용한다. mount 시점 1회만 읽으며
  // 이후 URL 동기화는 하지 않는다 (사용자가 자유롭게 바꿀 수 있도록).
  // 호출 진입점:
  //   - /admin/members 의 "작성 기간" 버튼 → ?q=<userId>
  //   - Cluster2 Review Link / Cluster3 Output|Detail 의 "작성 기간 관리" 버튼
  //     → ?q=<userId>&resource=<resource_key>
  // resource_key 가 EDITABLE_RESOURCES 에 없으면 DEFAULT 로 fallback.
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
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [rows, setRows] = useState<EditWindowUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState<Banner>(null);
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set("resource_key", resourceKey);
      if (debouncedQuery) params.set("q", debouncedQuery);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      try {
        const res = await fetch(`/api/admin/edit-windows?${params}`, {
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
  }, [resourceKey, debouncedQuery, offset, refreshTick]);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(t);
  }, [banner]);

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
      await bulkWindow({
        resource_key: resourceKey,
        opened_at: openedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        user_ids: Array.from(selectedUserIds),
        select_all_matching: allMatchingSelected,
        filters: { q: debouncedQuery },
      })
        .then((count) => {
          clearSelection();
          reload();
          setBanner({
            kind: "success",
            message: `${count}명에게 ${getResourceLabel(resourceKey)} 권한을 부여했습니다.`,
          });
        })
        .catch((err: Error) => {
          setBanner({ kind: "error", message: err.message });
        });
    },
    [
      allMatchingSelected,
      clearSelection,
      debouncedQuery,
      resourceKey,
      selectedUserIds,
    ],
  );

  const handleBulkClose = useCallback(async () => {
    await bulkWindow({
      resource_key: resourceKey,
      action: "close",
      user_ids: Array.from(selectedUserIds),
      select_all_matching: allMatchingSelected,
      filters: { q: debouncedQuery },
    })
      .then((count) => {
        clearSelection();
        reload();
        setBanner({
          kind: "success",
          message: `${count}명의 ${getResourceLabel(resourceKey)} 권한을 닫았습니다.`,
        });
      })
      .catch((err: Error) => {
        setBanner({ kind: "error", message: err.message });
      });
  }, [
    allMatchingSelected,
    clearSelection,
    debouncedQuery,
    resourceKey,
    selectedUserIds,
  ]);

  const applyWindowToRow = useCallback(
    (userId: string, window: EditWindowDto | null) => {
      setRows((prev) =>
        prev.map((r) => (r.userId === userId ? { ...r, window } : r)),
      );
      // editing 상태도 동일하게 업데이트.
      setEditing((prev) =>
        prev && prev.userId === userId ? { ...prev, window } : prev,
      );
    },
    [],
  );

  const handleQuickAction = useCallback(
    async (row: EditWindowUserRow, action: QuickActionKey) => {
      const { openedAt, expiresAt } = computeQuickActionRange(action);
      await patchWindow(row.userId, {
        resource_key: resourceKey,
        opened_at: openedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
        .then((win) => {
          applyWindowToRow(row.userId, win);
          setBanner({
            kind: "success",
            message: `${row.displayName ?? row.userId} · ${getResourceLabel(
              resourceKey,
            )} 권한을 부여했습니다.`,
          });
        })
        .catch((err: Error) => {
          setBanner({ kind: "error", message: err.message });
        });
    },
    [resourceKey, applyWindowToRow],
  );

  const handleClose = useCallback(
    async (row: EditWindowUserRow) => {
      await patchWindow(row.userId, {
        resource_key: resourceKey,
        action: "close",
      })
        .then((win) => {
          applyWindowToRow(row.userId, win);
          setBanner({
            kind: "success",
            message: `${row.displayName ?? row.userId} · ${getResourceLabel(
              resourceKey,
            )} 권한을 닫았습니다.`,
          });
        })
        .catch((err: Error) => {
          setBanner({ kind: "error", message: err.message });
        });
    },
    [resourceKey, applyWindowToRow],
  );

  const pageEnd = offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            작성 기간 관리
          </h2>
          <p className="text-sm text-muted-foreground">
            사용자별 / 리소스별 편집 가능 기간을 열고 닫습니다. 기준 테이블:{" "}
            <code className="mx-1 font-mono">public.user_edit_windows</code>
          </p>
        </div>
        <Button variant="outline" onClick={reload} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

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
          <CardTitle className="text-base">사용자 & 리소스</CardTitle>
          <CardDescription>
            리소스를 선택하고 사용자를 검색한 뒤, 빠른 액션이나 직접 기간 설정으로
            권한을 부여하세요.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[260px_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resource-key">리소스</Label>
              <Select
                value={resourceKey}
                onValueChange={(v: string | null) => {
                  setResourceKey(v ?? DEFAULT_RESOURCE_KEY);
                  setOffset(0);
                  setSelectedUserIds(new Set());
                  setAllMatchingSelected(false);
                }}
              >
                <SelectTrigger id="resource-key">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EDITABLE_RESOURCES.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {EDITABLE_RESOURCES.find((r) => r.key === resourceKey)
                  ?.description ?? ""}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-search">사용자 검색</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="user-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="display_name, auth_email, contact_email, organization, user_id"
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

          <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pageAllSelected}
                  onChange={(e) => handleTogglePage(e.target.checked)}
                  aria-label="현재 페이지 전체 선택"
                />
                현재 페이지 전체 선택
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
                disabled={selectedCount === 0}
                onClick={() => void handleBulkQuickAction("open_24h")}
              >
                24시간 열기
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0}
                onClick={() => void handleBulkQuickAction("open_7d")}
              >
                7일 열기
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0}
                onClick={() => setBulkEditing(true)}
              >
                직접 기간 설정
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedCount === 0}
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
                  <TableHead className="w-10">
                    <span className="sr-only">선택</span>
                  </TableHead>
                  <TableHead>이름 / user_id</TableHead>
                  <TableHead>auth_email</TableHead>
                  <TableHead>소속</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>기간</TableHead>
                  <TableHead className="w-[320px] text-right">액션</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = computeEditWindowStatus(row.window);
                  return (
                    <TableRow key={row.userId}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={
                            allMatchingSelected ||
                            selectedUserIds.has(row.userId)
                          }
                          onChange={(e) =>
                            handleToggleUser(row.userId, e.target.checked)
                          }
                          aria-label={`${row.displayName ?? row.userId} 선택`}
                        />
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <div className="font-medium">
                          {fmt(row.displayName)}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {row.userId}
                        </div>
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
                              {fmtDate(row.window.openedAt)}
                            </span>
                            <span>
                              <span className="text-muted-foreground">만료</span>{" "}
                              {fmtDate(row.window.expiresAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              void handleQuickAction(row, "open_24h")
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            24h
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleQuickAction(row, "open_7d")
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            7d
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleQuickAction(
                                row,
                                "open_until_midnight",
                              )
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            자정
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleClose(row)}
                            disabled={status !== "open"}
                            className={cn(
                              "rounded-md border px-2 py-1 text-xs",
                              status === "open"
                                ? "hover:bg-muted"
                                : "cursor-not-allowed text-muted-foreground",
                            )}
                          >
                            닫기
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            className="rounded-md border bg-foreground px-2 py-1 text-xs text-background hover:opacity-90"
                          >
                            기간 설정
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && rows.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 사용자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      불러오는 중...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {total === 0
                ? "0건"
                : `${(offset + 1).toLocaleString()}–${pageEnd.toLocaleString()} / ${total.toLocaleString()}건`}
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
        onClose={() => setEditing(null)}
        onSaved={(userId, window) => {
          applyWindowToRow(userId, window);
          setEditing(null);
          setBanner({
            kind: "success",
            message: `${getResourceLabel(resourceKey)} 기간이 저장되었습니다.`,
          });
        }}
      />
      <BulkEditWindowDrawer
        open={bulkEditing}
        resourceKey={resourceKey}
        selectedCount={selectedCount}
        onClose={() => setBulkEditing(false)}
        onSaved={(count) => {
          setBulkEditing(false);
          clearSelection();
          reload();
          setBanner({
            kind: "success",
            message: `${count}명에게 ${getResourceLabel(resourceKey)} 기간을 저장했습니다.`,
          });
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

// ─────────────────────────────────────────────────────────────────────────
// PATCH helper
// ─────────────────────────────────────────────────────────────────────────

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
): Promise<EditWindowDto | null> {
  const res = await fetch(
    `/api/admin/edit-windows/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

async function bulkWindow(body: BulkUpsertBody | BulkCloseBody): Promise<number> {
  const res = await fetch("/api/admin/edit-windows/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json?.error ?? "Failed to save selected users");
  }
  return Number(json.data?.count ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Drawer: 직접 기간 설정 + note
// ─────────────────────────────────────────────────────────────────────────

function EditWindowDrawer({
  row,
  resourceKey,
  onClose,
  onSaved,
}: {
  row: EditWindowUserRow | null;
  resourceKey: string;
  onClose: () => void;
  onSaved: (userId: string, window: EditWindowDto | null) => void;
}) {
  if (!row) return null;
  return (
    <EditWindowDrawerInner
      key={`${row.userId}:${resourceKey}`}
      row={row}
      resourceKey={resourceKey}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function EditWindowDrawerInner({
  row,
  resourceKey,
  onClose,
  onSaved,
}: {
  row: EditWindowUserRow;
  resourceKey: string;
  onClose: () => void;
  onSaved: (userId: string, window: EditWindowDto | null) => void;
}) {
  const initial = useMemo(() => {
    const w = row.window;
    if (w) {
      return {
        opened: toLocalInputValue(new Date(w.openedAt)),
        expires: toLocalInputValue(new Date(w.expiresAt)),
        note: w.note ?? "",
      };
    }
    // 기본값: 지금부터 7일.
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
  }, [saving, onClose]);

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
    if (Number.isNaN(openedDate.getTime()) || Number.isNaN(expiresDate.getTime())) {
      setError("올바른 날짜를 입력하세요.");
      return;
    }
    if (expiresDate.getTime() <= openedDate.getTime()) {
      setError("만료 시각은 시작 시각보다 이후여야 합니다.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const window = await patchWindow(row.userId, {
        resource_key: resourceKey,
        opened_at: openedDate.toISOString(),
        expires_at: expiresDate.toISOString(),
        note: note.trim() ? note.trim() : null,
      });
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
      aria-label="작성 기간 설정"
      className="fixed inset-0 z-50 flex"
    >
      <div
        className="absolute inset-0 bg-foreground/40"
        onClick={() => !saving && onClose()}
      />
      <div className="relative ml-auto flex h-full w-full max-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">작성 기간 설정</h3>
            <p className="text-xs text-muted-foreground">
              {row.displayName ?? "(이름 없음)"}
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                {row.userId}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              리소스: <code className="font-mono">{resourceKey}</code>
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
            <div className="flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => handleQuick(q.key)}
                  className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {q.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-opened">시작 (opened_at)</Label>
              <Input
                id="window-opened"
                type="datetime-local"
                value={opened}
                onChange={(e) => setOpened(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-expires">만료 (expires_at)</Label>
              <Input
                id="window-expires"
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="window-note">메모 (note)</Label>
              <Input
                id="window-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 1차 작성 마감 연장"
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
            <Button type="submit" disabled={saving}>
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
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
  selectedCount,
  onClose,
  onSaved,
  getPayloadBase,
}: {
  open: boolean;
  resourceKey: string;
  selectedCount: number;
  onClose: () => void;
  onSaved: (count: number) => void;
  getPayloadBase: () => BulkPayloadBase;
}) {
  if (!open) return null;
  return (
    <BulkEditWindowDrawerInner
      resourceKey={resourceKey}
      selectedCount={selectedCount}
      onClose={onClose}
      onSaved={onSaved}
      getPayloadBase={getPayloadBase}
    />
  );
}

function BulkEditWindowDrawerInner({
  resourceKey,
  selectedCount,
  onClose,
  onSaved,
  getPayloadBase,
}: {
  resourceKey: string;
  selectedCount: number;
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
  }, [saving, onClose]);

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
    if (Number.isNaN(openedDate.getTime()) || Number.isNaN(expiresDate.getTime())) {
      setError("올바른 날짜를 입력하세요.");
      return;
    }
    if (expiresDate.getTime() <= openedDate.getTime()) {
      setError("만료 시각은 시작 시각보다 이후여야 합니다.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const count = await bulkWindow({
        ...getPayloadBase(),
        resource_key: resourceKey,
        opened_at: openedDate.toISOString(),
        expires_at: expiresDate.toISOString(),
        note: note.trim() ? note.trim() : null,
      });
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
      aria-label="선택 사용자 작성 기간 설정"
      className="fixed inset-0 z-50 flex"
    >
      <div
        className="absolute inset-0 bg-foreground/40"
        onClick={() => !saving && onClose()}
      />
      <div className="relative ml-auto flex h-full w-full max-w-md flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-base font-semibold">선택 기간 설정</h3>
            <p className="text-xs text-muted-foreground">
              선택됨: {selectedCount.toLocaleString()}명
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              리소스: <code className="font-mono">{resourceKey}</code>
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
            <div className="flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => handleQuick(q.key)}
                  className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {q.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-opened">시작 (opened_at)</Label>
              <Input
                id="bulk-window-opened"
                type="datetime-local"
                value={opened}
                onChange={(e) => setOpened(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-expires">만료 (expires_at)</Label>
              <Input
                id="bulk-window-expires"
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-window-note">메모 (note)</Label>
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
            <Button type="submit" disabled={saving || selectedCount === 0}>
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
              저장
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
