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
import { cn } from "@/lib/utils";
import { APP_USER_STATUSES } from "@/lib/adminAppUsersTypes";

type AppUser = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const STATUS_ALL = "__all__";

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

export default function AppUsersList() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState<string>(STATUS_ALL);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (debouncedQuery) params.set("query", debouncedQuery);
      if (status !== STATUS_ALL) params.set("status", status);
      const url = `/api/admin/app-users${params.size ? `?${params}` : ""}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load users.");
        }
        if (!cancelled) setUsers((json.data ?? []) as AppUser[]);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load users.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, status, refreshTick]);

  const summary = useMemo(() => {
    if (loading) return "불러오는 중...";
    return `총 ${users.length}명`;
  }, [users.length, loading]);

  const reload = () => setRefreshTick((n) => n + 1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">가입된 사용자</h2>
          <p className="text-sm text-muted-foreground">
            사용자 페이지(user-app)에 가입된 계정 목록입니다. 기준 테이블:
            <code className="mx-1 font-mono">public.user_profiles</code>
          </p>
        </div>
        <Button
          variant="outline"
          onClick={reload}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">사용자 목록</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="이름, contact_email, auth_email, organization, user_id 검색"
                className="pl-9"
              />
            </div>
            <div className="w-full sm:w-56">
              <Select
                value={status}
                onValueChange={(v) => setStatus(v ?? STATUS_ALL)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="상태 필터" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_ALL}>전체 상태</SelectItem>
                  {APP_USER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
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
                  <TableHead>이름</TableHead>
                  <TableHead>연락 이메일</TableHead>
                  <TableHead>로그인 이메일</TableHead>
                  <TableHead>소속</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>가입일</TableHead>
                  <TableHead>최근 수정</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell className="max-w-[180px]">
                      <div className="font-medium">{fmt(user.displayName)}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {user.userId}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">
                      {fmt(user.contactEmail)}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">
                      {fmt(user.authEmail)}
                    </TableCell>
                    <TableCell>{fmt(user.organizationSlug)}</TableCell>
                    <TableCell>{fmt(user.status)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDate(user.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && users.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 사용자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && users.length === 0 && (
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
        </CardContent>
      </Card>
    </div>
  );
}
