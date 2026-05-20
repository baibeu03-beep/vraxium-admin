"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Search } from "lucide-react";
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
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

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

type OrganizationOption = {
  slug: string;
  name: string;
  type: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const STATUS_ALL = "__all__";
const ORG_NONE = "__none__";

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
  const devMode = useAdminDevMode();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState<string>(STATUS_ALL);
  const [refreshTick, setRefreshTick] = useState(0);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [organizationsError, setOrganizationsError] = useState<string | null>(
    null,
  );
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

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

  useEffect(() => {
    let cancelled = false;
    const loadOrganizations = async () => {
      setOrganizationsError(null);
      try {
        const res = await fetch("/api/admin/organizations", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json?.error ?? "Failed to load organizations.");
        }
        if (!cancelled) {
          setOrganizations(
            (json.organizations ?? []) as OrganizationOption[],
          );
        }
      } catch (err) {
        if (!cancelled) {
          setOrganizationsError(
            err instanceof Error
              ? err.message
              : "Failed to load organizations.",
          );
        }
      }
    };
    void loadOrganizations();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const summary = useMemo(() => {
    if (loading) return "불러오는 중...";
    return `총 ${users.length}명`;
  }, [users.length, loading]);

  const reload = () => setRefreshTick((n) => n + 1);

  const orgLookup = useMemo(() => {
    const map = new Map<string, OrganizationOption>();
    for (const org of organizations) {
      map.set(org.slug, org);
    }
    return map;
  }, [organizations]);

  const handleOrganizationChange = async (
    user: AppUser,
    nextValue: string,
  ) => {
    if (savingUserId) return;
    const nextSlug = nextValue === ORG_NONE ? null : nextValue;
    if ((user.organizationSlug ?? null) === nextSlug) return;

    setSavingUserId(user.userId);
    try {
      const res = await fetch(
        `/api/admin/user-profiles/${encodeURIComponent(user.userId)}/organization`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization_slug: nextSlug }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? "Failed to update organization.");
      }
      const updatedSlug: string | null =
        json?.user_profile?.organization_slug ?? nextSlug;
      setUsers((prev) =>
        prev.map((u) =>
          u.userId === user.userId
            ? {
                ...u,
                organizationSlug: updatedSlug,
                updatedAt: json?.user_profile?.updated_at ?? u.updatedAt,
              }
            : u,
        ),
      );
      const label = updatedSlug
        ? orgLookup.get(updatedSlug)?.name ?? updatedSlug
        : "소속 없음";
      setBanner({
        kind: "success",
        message: `${user.displayName ?? user.userId} 소속을 ${label}(으)로 변경했습니다.`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to update organization.",
      });
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">가입된 사용자</h2>
          <p className="text-sm text-muted-foreground">
            {devMode
              ? "사용자 페이지(user-app)에 가입된 계정 목록입니다."
              : "회원 페이지에 가입된 계정 목록입니다."}
            {devMode && (
              <>
                {" "}
                기준 테이블:
                <code className="mx-1 font-mono">public.user_profiles</code>
              </>
            )}
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

      {organizationsError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          조직 목록을 불러오지 못했습니다: {organizationsError}
        </div>
      )}

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
                placeholder={
                  devMode
                    ? "이름, contact_email, auth_email, organization, user_id 검색"
                    : "이름, 이메일, 소속, 회원 ID로 검색"
                }
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
                  <TableHead className="w-[200px]">소속</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>가입일</TableHead>
                  <TableHead>최근 수정</TableHead>
                  <TableHead className="w-[200px] text-right">관리</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const isSaving = savingUserId === user.userId;
                  const currentSlug = user.organizationSlug;
                  const currentInOptions =
                    !currentSlug || orgLookup.has(currentSlug);
                  const selectValue = currentSlug ?? ORG_NONE;
                  return (
                    <TableRow key={user.userId}>
                      <TableCell className="max-w-[180px]">
                        <div className="font-medium">{fmt(user.displayName)}</div>
                        {devMode && (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {user.userId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(user.contactEmail)}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(user.authEmail)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Select
                            value={selectValue}
                            onValueChange={(v) =>
                              void handleOrganizationChange(user, v ?? ORG_NONE)
                            }
                            disabled={
                              isSaving ||
                              Boolean(savingUserId) ||
                              organizations.length === 0
                            }
                          >
                            <SelectTrigger className="h-8 w-[150px] text-xs">
                              <SelectValue placeholder="소속 선택" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ORG_NONE}>소속 없음</SelectItem>
                              {!currentInOptions && currentSlug && (
                                <SelectItem value={currentSlug} disabled>
                                  {currentSlug} (목록 외)
                                </SelectItem>
                              )}
                              {organizations.map((org) => (
                                <SelectItem key={org.slug} value={org.slug}>
                                  {org.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {isSaving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{fmt(user.status)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(user.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(user.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {currentSlug ? (
                          <div className="flex justify-end items-center gap-1">
                            <Link
                              href={
                                `/admin/crews/${encodeURIComponent(
                                  currentSlug,
                                )}/${encodeURIComponent(user.userId)}` +
                                (devMode ? "?dev=true" : "")
                              }
                              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              Resume
                            </Link>
                            <Link
                              href={
                                `/admin/crews/${encodeURIComponent(
                                  currentSlug,
                                )}/${encodeURIComponent(
                                  user.userId,
                                )}/cluster2` + (devMode ? "?dev=true" : "")
                              }
                              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              Cluster 2
                            </Link>
                          </div>
                        ) : (
                          <span
                            className="text-[10px] text-muted-foreground"
                            title={
                              devMode
                                ? "organization_slug 가 없는 사용자입니다. 소속을 먼저 지정하세요."
                                : "소속이 지정되지 않은 회원입니다. 소속을 먼저 지정하세요."
                            }
                          >
                            소속 필요
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && users.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 사용자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && users.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-10 text-center text-muted-foreground"
                    >
                      불러오는 중...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            {devMode ? (
              <>
                소속을 변경하면 즉시{" "}
                <code className="font-mono">user_profiles.organization_slug</code>{" "}
                컬럼이 업데이트됩니다. 신규/무소속 사용자의 최초 조직 배정은 이
                화면에서 진행합니다.
              </>
            ) : (
              <>
                소속을 변경하면 즉시 회원 정보에 반영됩니다. 신규 또는 무소속
                회원의 첫 소속 지정은 이 화면에서 진행합니다.
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
