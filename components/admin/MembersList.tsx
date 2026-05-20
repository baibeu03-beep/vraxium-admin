"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
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
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import { APP_USER_STATUSES } from "@/lib/adminAppUsersTypes";
import {
  MEMBER_SORT_COLUMNS,
  isMemberSortColumn,
  type MemberSortColumn,
  type MemberSortDir,
} from "@/lib/adminMembersTypes";
import MemberEditDrawer, {
  type EditableMember,
} from "@/components/admin/MemberEditDrawer";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

type Member = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  growthStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const FILTER_ALL = "__all__";
const ORG_NONE = "__none__";
const PRESENCE_HAS = "has";
const PRESENCE_MISSING = "missing";
const PAGE_SIZE = 100;

const GROWTH_STATUSES = APP_USER_STATUSES;

function buildColumns(devMode: boolean): { key: MemberSortColumn; label: string }[] {
  return [
    { key: "display_name", label: devMode ? "이름 / user_id" : "이름" },
    { key: "contact_email", label: "연락 이메일" },
    { key: "auth_email", label: devMode ? "auth_email" : "로그인 이메일" },
    { key: "organization_slug", label: "소속" },
    { key: "status", label: "상태" },
    { key: "growth_status", label: "성장" },
    { key: "created_at", label: "가입일" },
    { key: "updated_at", label: "최근 수정" },
  ];
}

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

function orgLabel(slug: string | null | undefined) {
  if (!slug) return "미지정";
  if (slug in ORGANIZATION_LABEL) {
    return ORGANIZATION_LABEL[slug as keyof typeof ORGANIZATION_LABEL];
  }
  return slug;
}

type Banner = { kind: "success" | "error"; message: string } | null;

type Sort = { col: MemberSortColumn; dir: MemberSortDir };

export default function MembersList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const devMode = useAdminDevMode();

  // 정렬은 nullable. null = "기본 정렬"(서버에서 created_at desc 적용).
  // 초기값은 URL 의 sort= 가 있으면 사용, 없으면 null.
  const initialSort = useMemo<Sort | null>(() => {
    const raw = searchParams.get("sort");
    if (!raw) return null;
    const [col, dir] = raw.split(".");
    if (col && isMemberSortColumn(col)) {
      return {
        col,
        dir: (dir === "asc" ? "asc" : "desc") as MemberSortDir,
      };
    }
    return null;
    // 의도적으로 mount 시점 1회만 평가.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [members, setMembers] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [withoutOrgCount, setWithoutOrgCount] = useState(0);
  const [withoutAuthCount, setWithoutAuthCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [organization, setOrganization] = useState<string>(FILTER_ALL);
  const [status, setStatus] = useState<string>(FILTER_ALL);
  const [growthStatus, setGrowthStatus] = useState<string>(FILTER_ALL);
  const [authEmailPresence, setAuthEmailPresence] = useState<string>(FILTER_ALL);
  const [contactEmailPresence, setContactEmailPresence] = useState<string>(FILTER_ALL);
  const [sort, setSort] = useState<Sort | null>(initialSort);
  const [offset, setOffset] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);

  const [editing, setEditing] = useState<EditableMember | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  // 검색어 디바운스 + 필터 변경 시 첫 페이지로 이동
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

  // URL ?sort= 동기화. none(=null) 상태에서는 ?sort 를 제거한다.
  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    const current = next.get("sort");
    if (sort) {
      const value = `${sort.col}.${sort.dir}`;
      if (current === value) return;
      next.set("sort", value);
    } else {
      if (current == null) return;
      next.delete("sort");
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sort, pathname, router, searchParams]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (organization !== FILTER_ALL) params.set("organization", organization);
      if (status !== FILTER_ALL) params.set("status", status);
      if (growthStatus !== FILTER_ALL) params.set("growth_status", growthStatus);
      if (authEmailPresence !== FILTER_ALL) params.set("auth_email", authEmailPresence);
      if (contactEmailPresence !== FILTER_ALL) params.set("contact_email", contactEmailPresence);
      if (sort) params.set("sort", `${sort.col}.${sort.dir}`);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));

      try {
        const res = await fetch(`/api/admin/members?${params}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load members.");
        }
        if (!cancelled) {
          setMembers((json.data?.members ?? []) as Member[]);
          setTotal(Number(json.data?.total ?? 0));
          setWithoutOrgCount(Number(json.data?.withoutOrganizationCount ?? 0));
          setWithoutAuthCount(Number(json.data?.withoutAuthEmailCount ?? 0));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load members.");
          setMembers([]);
          setTotal(0);
          setWithoutOrgCount(0);
          setWithoutAuthCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    debouncedQuery,
    organization,
    status,
    growthStatus,
    authEmailPresence,
    contactEmailPresence,
    sort,
    offset,
    refreshTick,
  ]);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(t);
  }, [banner]);

  const filtersApplied = useMemo(() => {
    return (
      Boolean(debouncedQuery) ||
      organization !== FILTER_ALL ||
      status !== FILTER_ALL ||
      growthStatus !== FILTER_ALL ||
      authEmailPresence !== FILTER_ALL ||
      contactEmailPresence !== FILTER_ALL
    );
  }, [
    debouncedQuery,
    organization,
    status,
    growthStatus,
    authEmailPresence,
    contactEmailPresence,
  ]);

  const reload = () => setRefreshTick((n) => n + 1);

  // 3-state cycle: none → asc → desc → none.
  // 다른 컬럼을 클릭하면 그 컬럼의 asc 부터 시작한다.
  const handleSort = useCallback((col: MemberSortColumn) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
    setOffset(0);
  }, []);

  const setFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v ?? FILTER_ALL);
    setOffset(0);
  };

  const handleSaved = (updated: EditableMember) => {
    setMembers((prev) =>
      prev.map((m) =>
        m.userId === updated.userId
          ? {
              ...m,
              organizationSlug: updated.organizationSlug,
              status: updated.status,
              growthStatus: updated.growthStatus,
              contactEmail: updated.contactEmail,
              contactPhone: updated.contactPhone,
            }
          : m,
      ),
    );
    setEditing(null);
    setBanner({
      kind: "success",
      message: `${updated.displayName ?? updated.userId} 정보가 저장되었습니다.`,
    });
    // 카운트는 서버 기준이므로 다시 가져온다.
    setRefreshTick((n) => n + 1);
  };

  const pageEnd = offset + members.length;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;
  const columns = useMemo(() => buildColumns(devMode), [devMode]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">전체 멤버</h2>
          <p className="text-sm text-muted-foreground">
            {devMode
              ? "조직과 관계없이 전체 사용자를 한 화면에서 운영합니다."
              : "소속과 관계없이 전체 회원을 한 화면에서 관리합니다."}
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

      {/* 요약 칩 */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryChip label="총" value={total} tone="primary" loading={loading} />
        <SummaryChip
          label="소속 없음"
          value={withoutOrgCount}
          tone={withoutOrgCount > 0 ? "warning" : "muted"}
          loading={loading}
        />
        <SummaryChip
          label={devMode ? "auth_email 없음" : "로그인 이메일 없음"}
          value={withoutAuthCount}
          tone={withoutAuthCount > 0 ? "warning" : "muted"}
          loading={loading}
        />
        {filtersApplied && (
          <span className="inline-flex items-center rounded-full border border-dashed bg-muted px-3 py-1 text-xs text-muted-foreground">
            필터 적용 중
          </span>
        )}
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
          <CardTitle className="text-base">멤버 목록</CardTitle>
          <CardDescription>
            컬럼 헤더를 클릭하면 정렬, 헤더 아래 셀에서 컬럼별 필터를 조정할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 검색 */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                devMode
                  ? "이름, contact_email, auth_email, user_id 검색"
                  : "이름, 이메일, 회원 ID로 검색"
              }
              className="pl-9"
            />
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
                  {columns.map((c) => {
                    const active = sort?.col === c.key;
                    return (
                      <SortableHeader
                        key={c.key}
                        column={c.key}
                        label={c.label}
                        dir={active ? sort?.dir ?? null : null}
                        onSort={handleSort}
                      />
                    );
                  })}
                  <TableHead className="w-[460px] text-right">바로가기</TableHead>
                </TableRow>
                {/* Column filter row */}
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell className="py-2" />
                  <TableCell className="py-2">
                    <PresenceMiniSelect
                      value={contactEmailPresence}
                      onChange={setFilter(setContactEmailPresence)}
                    />
                  </TableCell>
                  <TableCell className="py-2">
                    <PresenceMiniSelect
                      value={authEmailPresence}
                      onChange={setFilter(setAuthEmailPresence)}
                    />
                  </TableCell>
                  <TableCell className="py-2">
                    <Select
                      value={organization}
                      onValueChange={(v: string | null) =>
                        setFilter(setOrganization)(v ?? FILTER_ALL)
                      }
                    >
                      <SelectTrigger className="h-8 w-[140px] text-xs">
                        <SelectValue>
                          {(value: unknown) => orgFilterLabel(value)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={FILTER_ALL}>전체</SelectItem>
                        {ORGANIZATIONS.map((slug) => (
                          <SelectItem key={slug} value={slug}>
                            {ORGANIZATION_LABEL[slug]}
                          </SelectItem>
                        ))}
                        <SelectItem value={ORG_NONE}>미지정</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="py-2">
                    <StatusMiniSelect
                      value={status}
                      onChange={setFilter(setStatus)}
                    />
                  </TableCell>
                  <TableCell className="py-2">
                    <StatusMiniSelect
                      value={growthStatus}
                      onChange={setFilter(setGrowthStatus)}
                      values={GROWTH_STATUSES}
                    />
                  </TableCell>
                  <TableCell className="py-2" />
                  <TableCell className="py-2" />
                  <TableCell className="py-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const slug = member.organizationSlug;
                  return (
                    <TableRow key={member.userId}>
                      <TableCell className="max-w-[220px]">
                        <div className="font-medium">{fmt(member.displayName)}</div>
                        {devMode && (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {member.userId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(member.contactEmail)}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(member.authEmail)}
                      </TableCell>
                      <TableCell>{orgLabel(slug)}</TableCell>
                      <TableCell>{fmt(member.status)}</TableCell>
                      <TableCell>{fmt(member.growthStatus)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(member.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(member.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {slug ? (
                            <>
                              <Link
                                href={
                                  `/admin/crews/${encodeURIComponent(
                                    slug,
                                  )}/${encodeURIComponent(member.userId)}` +
                                  (devMode ? "?dev=true" : "")
                                }
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Resume Card
                              </Link>
                              <Link
                                href={
                                  `/admin/crews/${encodeURIComponent(
                                    slug,
                                  )}/${encodeURIComponent(
                                    member.userId,
                                  )}/cluster2` + (devMode ? "?dev=true" : "")
                                }
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Cluster 2
                              </Link>
                              <Link
                                href={
                                  `/admin/crews/${encodeURIComponent(
                                    slug,
                                  )}/${encodeURIComponent(
                                    member.userId,
                                  )}/cluster3` + (devMode ? "?dev=true" : "")
                                }
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Cluster 3
                              </Link>
                            </>
                          ) : (
                            <>
                              <span
                                aria-disabled
                                title={
                                  devMode
                                    ? "organization_slug 가 없는 사용자입니다. 멤버 정보 수정에서 소속을 먼저 지정하세요."
                                    : "소속이 지정되지 않은 회원입니다. '멤버 정보 수정'에서 소속을 먼저 지정하세요."
                                }
                                className="cursor-not-allowed rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
                              >
                                Resume Card
                              </span>
                              <span
                                aria-disabled
                                title={
                                  devMode
                                    ? "organization_slug 가 없는 사용자입니다."
                                    : "소속이 지정되지 않은 회원입니다."
                                }
                                className="cursor-not-allowed rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
                              >
                                Cluster 2
                              </span>
                              <span
                                aria-disabled
                                title={
                                  devMode
                                    ? "organization_slug 가 없는 사용자입니다."
                                    : "소속이 지정되지 않은 회원입니다."
                                }
                                className="cursor-not-allowed rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
                              >
                                Cluster 3
                              </span>
                            </>
                          )}
                          <Link
                            href={
                              `/admin/settings/edit-windows?q=${encodeURIComponent(
                                member.userId,
                              )}` + (devMode ? "&dev=true" : "")
                            }
                            title={
                              devMode
                                ? "이 사용자의 작성 기간 관리로 이동"
                                : "이 회원의 작성 기간 관리로 이동"
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            작성 기간
                          </Link>
                          <button
                            type="button"
                            onClick={() =>
                              setEditing({
                                userId: member.userId,
                                displayName: member.displayName,
                                authEmail: member.authEmail,
                                organizationSlug: member.organizationSlug,
                                status: member.status,
                                growthStatus: member.growthStatus,
                                contactEmail: member.contactEmail,
                                contactPhone: member.contactPhone,
                              })
                            }
                            className="rounded-md border bg-foreground px-2 py-1 text-xs text-background hover:opacity-90"
                          >
                            멤버 정보 수정
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && members.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + 1}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 멤버가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && members.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + 1}
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
                <ChevronLeft className="h-4 w-4" />
                이전
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || loading}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                다음
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <MemberEditDrawer
        member={editing}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    </div>
  );
}

function SortableHeader({
  column,
  label,
  dir,
  onSort,
}: {
  column: MemberSortColumn;
  label: string;
  dir: MemberSortDir | null;
  onSort: (col: MemberSortColumn) => void;
}) {
  if (!MEMBER_SORT_COLUMNS.includes(column)) return null;
  const active = dir != null;
  const nextStateLabel = !active
    ? "오름차순 정렬"
    : dir === "asc"
      ? "내림차순 정렬"
      : "정렬 해제";
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`${label} — ${nextStateLabel}`}
        title={nextStateLabel}
        className={cn(
          "inline-flex items-center gap-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground",
          active && "text-foreground",
        )}
      >
        <span>{label}</span>
        {dir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : dir === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function orgFilterLabel(value: unknown): string {
  if (value === FILTER_ALL || value == null) return "전체";
  if (value === ORG_NONE) return "미지정";
  if (typeof value === "string" && isOrganizationSlug(value)) {
    return ORGANIZATION_LABEL[value];
  }
  return String(value);
}

function presenceFilterLabel(value: unknown): string {
  if (value === FILTER_ALL || value == null) return "전체";
  if (value === PRESENCE_HAS) return "있음";
  if (value === PRESENCE_MISSING) return "없음";
  return String(value);
}

function statusFilterLabel(value: unknown): string {
  if (value === FILTER_ALL || value == null) return "전체";
  return String(value);
}

function PresenceMiniSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v: string | null) => onChange(v ?? FILTER_ALL)}
    >
      <SelectTrigger className="h-8 w-[110px] text-xs">
        <SelectValue>{(v: unknown) => presenceFilterLabel(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>전체</SelectItem>
        <SelectItem value={PRESENCE_HAS}>있음</SelectItem>
        <SelectItem value={PRESENCE_MISSING}>없음</SelectItem>
      </SelectContent>
    </Select>
  );
}

function StatusMiniSelect({
  value,
  onChange,
  values = APP_USER_STATUSES,
}: {
  value: string;
  onChange: (v: string) => void;
  values?: readonly string[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(v: string | null) => onChange(v ?? FILTER_ALL)}
    >
      <SelectTrigger className="h-8 w-[130px] text-xs">
        <SelectValue>{(v: unknown) => statusFilterLabel(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>전체</SelectItem>
        {values.map((s) => (
          <SelectItem key={s} value={s}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SummaryChip({
  label,
  value,
  tone,
  loading,
}: {
  label: string;
  value: number;
  tone: "primary" | "warning" | "muted";
  loading: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
        tone === "primary" && "border-foreground/20 bg-foreground/5 text-foreground",
        tone === "warning" && "border-amber-300 bg-amber-50 text-amber-800",
        tone === "muted" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="font-mono">
        {loading ? "…" : value.toLocaleString()}
      </span>
    </span>
  );
}
