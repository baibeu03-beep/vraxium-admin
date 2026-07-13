"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { ADMIN_READ_ROLES } from "@/lib/adminAuthRoles";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { useReportLoading } from "@/components/admin/loadingBannerContext";

type AdminUser = {
  id: string;
  email: string | null;
  role: string | null;
  isActive: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const ROLE_ALL = "__all__";
const ACTIVE_ALL = "__all__";

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "—";
}

// createdAt·updatedAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "—" });
}

function roleLabel(role: string | null) {
  switch (role) {
    case "owner":
      return "소유자";
    case "admin":
      return "관리자";
    case "viewer":
      return "조회자";
    default:
      return role ?? "—";
  }
}

function roleBadgeClass(role: string | null) {
  switch (role) {
    case "owner":
      return "bg-violet-100 text-violet-800 ring-violet-200";
    case "admin":
      return "bg-blue-100 text-blue-800 ring-blue-200";
    case "viewer":
      return "bg-muted text-muted-foreground ring-border";
    default:
      return "bg-muted text-muted-foreground ring-border";
  }
}

export default function AdminUsersList() {
  const devMode = useAdminDevMode();
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string>(ROLE_ALL);
  const [active, setActive] = useState<string>(ACTIVE_ALL);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (role !== ROLE_ALL) params.set("role", role);
      if (active !== ACTIVE_ALL) params.set("active", active);
      const url = `/api/admin/admin-users${params.size ? `?${params}` : ""}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load admin users.");
        }
        if (!cancelled) setAdminUsers((json.data ?? []) as AdminUser[]);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load admin users.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [role, active, refreshTick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return adminUsers;
    return adminUsers.filter((user) => {
      const haystack = [user.email, user.role, user.id]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      return haystack.some((value) => value.includes(q));
    });
  }, [adminUsers, query]);

  const summary = loading
    ? "불러오는 중..."
    : `총 ${filtered.length}명${
        query.trim() && adminUsers.length !== filtered.length
          ? ` (전체 ${adminUsers.length}명 중 검색 결과)`
          : ""
      }`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">관리자 계정</h2>
          <p className="text-sm text-muted-foreground">
            {devMode
              ? "어드민 페이지에 로그인할 수 있는 계정 목록입니다."
              : "관리자 페이지에 로그인할 수 있는 계정 목록입니다."}
            {devMode && (
              <>
                {" "}
                기준 테이블:
                <code className="mx-1 font-mono">public.admin_users</code>
              </>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">관리자 목록</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={devMode ? "email, role, id 검색" : "이메일, 역할, ID로 검색"}
                className="pl-9"
              />
            </div>
            <div className="w-full sm:w-44">
              <Select
                value={role}
                onValueChange={(v) => setRole(v ?? ROLE_ALL)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="역할 필터" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROLE_ALL}>전체 역할</SelectItem>
                  {ADMIN_READ_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {devMode ? `${roleLabel(r)} (${r})` : roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-44">
              <Select
                value={active}
                onValueChange={(v) => setActive(v ?? ACTIVE_ALL)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="활성 필터" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ACTIVE_ALL}>전체</SelectItem>
                  <SelectItem value="true">활성</SelectItem>
                  <SelectItem value="false">비활성</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card border-r">
                    {devMode ? "Email" : "이메일"}
                  </TableHead>
                  <TableHead>역할</TableHead>
                  <TableHead>활성</TableHead>
                  <TableHead>생성일</TableHead>
                  <TableHead>최근 수정</TableHead>
                  {devMode && <TableHead>id</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="sticky left-0 z-10 bg-card border-r max-w-[260px] truncate font-medium">
                      {fmt(user.email)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                          roleBadgeClass(user.role),
                        )}
                      >
                        {roleLabel(user.role)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                          user.isActive
                            ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
                            : "bg-red-100 text-red-800 ring-red-200",
                        )}
                      >
                        {user.isActive ? "활성" : "비활성"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDate(user.updatedAt)}
                    </TableCell>
                    {devMode && (
                      <TableCell className="max-w-[280px] truncate font-mono text-[11px]" title={user.id}>
                        {user.id}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {!loading && filtered.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={devMode ? 6 : 5}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 관리자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && filtered.length === 0 && (
                  <TableSkeletonRows columns={devMode ? 6 : 5} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            관리자 초대/권한 변경 기능은 다음 단계에서 추가됩니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
