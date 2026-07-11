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
import { LoadingState } from "@/components/ui/loading-state";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  ORGANIZATIONS,
  ORGANIZATION_COMMON_LABEL,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import {
  WEEK_RECOGNITION_STATUSES,
  type WeekRecognitionRow,
  type WeekRecognitionsDto,
  type WeekRecognitionStatus,
  type WeekRecognitionWeekOption,
} from "@/lib/adminWeekRecognitionsTypes";
import { DEFAULT_WEEK_CHECK_THRESHOLD } from "@/lib/cluster4Enhancement";
import { formatClubDate, formatClubDateTime } from "@/lib/clubDate";

const ALL = "__all__";

// 상단 탭 — 인정 결과 목록과 check 기준 관리를 동시에 노출하지 않는다.
const VIEW_TABS = [
  { key: "recognitions", label: "주차 인정 결과", helpKey: "admin.weekRecognitions.tab.recognitions" },
  { key: "check_threshold", label: "check 기준 관리", helpKey: "admin.weekRecognitions.tab.checkThreshold" },
] as const;
type ViewTabKey = (typeof VIEW_TABS)[number]["key"];

type Banner = { kind: "success" | "error"; message: string } | null;

const STATUS_META: Record<string, { label: string; className: string }> = {
  success: {
    label: "인정",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  fail: {
    label: "미인정",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  personal_rest: {
    label: "개인 휴식",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  official_rest: {
    label: "공식 휴식",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

function statusLabel(status: string) {
  return STATUS_META[status]?.label ?? status;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return formatClubDate(value);
}

function formatRange(start: string | null, end: string | null) {
  if (!start && !end) return "-";
  if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`;
  return formatDate(start ?? end);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function orgLabel(slug: string | null | undefined) {
  if (!slug) return ORGANIZATION_COMMON_LABEL;
  if (isOrganizationSlug(slug)) return ORGANIZATION_LABEL[slug];
  return slug;
}

function StatusBadge({ row }: { row: WeekRecognitionRow }) {
  const meta = STATUS_META[row.status] ?? {
    label: row.status || "미상",
    className: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// 운영자 관점 주차 결과 확정 상태(KST date-only):
//   확정 완료 = result_published_at 있음 (고객 카드 성공/실패로 전환된 상태)
//   집계 중   = 미확정 + 종료 주차(오늘 KST > 종료일) — 결과 확정 가능 대상
//   진행 중   = 미확정 + 아직 진행/예정(오늘 KST ≤ 종료일)
// 주차 성공/실패 자체는 여기서 계산하지 않는다(기존 publishWeekResult / snapshot 로직 담당).
type ConfirmStatus = "진행 중" | "집계 중" | "확정 완료";

function kstToday(): string {
  return getCurrentActivityDateIso();
}

function confirmStatusOf(
  endDate: string | null,
  publishedAt: string | null,
): ConfirmStatus {
  if (publishedAt) return "확정 완료";
  if (endDate && kstToday() > endDate.slice(0, 10)) return "집계 중";
  return "진행 중";
}

function ConfirmStatusBadge({
  endDate,
  at,
}: {
  endDate: string | null;
  at: string | null;
}) {
  const status = confirmStatusOf(endDate, at);
  const cls =
    status === "확정 완료"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "집계 중"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-border bg-muted text-muted-foreground";
  const title =
    status === "확정 완료" && at
      ? `확정 완료 · ${formatClubDateTime(at)}`
      : status === "집계 중"
        ? "집계 중 — 결과 확정 전"
        : "진행 중";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        cls,
      )}
      title={title}
    >
      {status}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  tone = "default",
  loading,
  helpKey,
}: {
  label: string;
  value: number | null;
  tone?: "default" | "success" | "fail" | "rest" | "official";
  loading: boolean;
  helpKey?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        {helpKey ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{label}</span>
        )}
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone === "success" && "text-emerald-600",
            tone === "fail" && "text-red-600",
            tone === "rest" && "text-sky-600",
            tone === "official" && "text-amber-600",
          )}
        >
          {loading ? "…" : value == null ? "—" : value.toLocaleString()}
        </span>
      </CardContent>
    </Card>
  );
}

export default function WeekRecognitionsView() {
  const [data, setData] = useState<WeekRecognitionsDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading); // 전역 로딩 배너 보고
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [activeTab, setActiveTab] = useState<ViewTabKey>("recognitions");

  const [seasonKey, setSeasonKey] = useState<string>(ALL);
  const [weekId, setWeekId] = useState<string>(ALL);
  const [organization, setOrganization] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [editing, setEditing] = useState<WeekRecognitionRow | null>(null);
  const [publishTarget, setPublishTarget] =
    useState<WeekRecognitionWeekOption | null>(null);
  const [reviewTarget, setReviewTarget] =
    useState<WeekRecognitionWeekOption | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(t);
  }, [banner]);

  // 검색어 디바운스.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // QA 모드(?mode=test) — 조회/쓰기 전부에 전파해야 백엔드 스코프(테스트 유저만)와 정합한다.
  const mode = readScopeMode(useSearchParams());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (seasonKey !== ALL) params.set("season_key", seasonKey);
      if (weekId !== ALL) params.set("week_id", weekId);
      if (organization !== ALL) params.set("organization_slug", organization);
      if (status !== ALL) params.set("status", status);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (mode === "test") params.set("mode", "test");

      try {
        const res = await fetch(
          `/api/admin/week-recognitions?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load week recognitions.");
        }
        if (!cancelled) setData(json.data as WeekRecognitionsDto);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load week recognitions.",
          );
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [seasonKey, weekId, organization, status, debouncedSearch, refreshTick, mode]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const handleSaved = useCallback(
    (updatedName: string | null, recalcSkipped: boolean) => {
      setEditing(null);
      setBanner(
        recalcSkipped
          ? {
              kind: "error",
              message: `${updatedName ?? "사용자"} 주차 상태는 저장됐지만 요약 캐시(승인/누적 주차) 동기화에 실패했습니다. 값이 어긋날 수 있습니다.`,
            }
          : {
              // 내부 처리(요약 캐시 동기화)는 UI 에 노출하지 않고 결과만 간결히. 실패 시(위 error 분기)에만
              //   값 불일치 가능성을 안내한다.
              kind: "success",
              message: `${updatedName ?? "사용자"} 주차 상태를 저장했습니다.`,
            },
      );
      // 현재 필터 조건 그대로 목록 재조회.
      setRefreshTick((n) => n + 1);
    },
    [],
  );

  const handlePublished = useCallback((label: string) => {
    setPublishTarget(null);
    setBanner({
      kind: "success",
      message: `${label} 결과를 확정했습니다. 크루 페이지에서 이 주차 카드가 성공/실패 상태로 전환됩니다.`,
    });
    setRefreshTick((n) => n + 1);
  }, []);

  const handleReviewed = useCallback((label: string) => {
    setReviewTarget(null);
    setBanner({
      kind: "success",
      message: `${label} 검수를 완료했습니다. /weekly-ranking 에서 이 주차 카드가 "검수 완료"로 표시됩니다.`,
    });
    setRefreshTick((n) => n + 1);
  }, []);

  const seasons = data?.seasons ?? [];
  const allWeeks = data?.weeks ?? [];
  const rows = data?.rows ?? [];
  const summary = data?.summary;

  // 단일 주차가 선택됐을 때만 그 주차의 결과 확정 상태/액션 패널을 노출한다.
  const selectedWeek = useMemo(
    () =>
      weekId === ALL
        ? null
        : allWeeks.find((w) => w.week_id === weekId) ?? null,
    [allWeeks, weekId],
  );

  // 주차 드롭다운은 선택된 시즌에 속한 주차만 노출(시즌 미선택이면 전체).
  const weekOptions = useMemo(() => {
    if (seasonKey === ALL) return allWeeks;
    return allWeeks.filter((w) => w.season_key === seasonKey);
  }, [allWeeks, seasonKey]);

  // 시즌을 바꾸면 현재 선택된 주차가 그 시즌에 없으면 주차 필터를 초기화.
  useEffect(() => {
    if (weekId === ALL) return;
    if (!weekOptions.some((w) => w.week_id === weekId)) {
      setWeekId(ALL);
    }
  }, [weekOptions, weekId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold tracking-tight">주차 인정 결과</h2>
          <p className="text-sm text-muted-foreground">
            특정 주차 또는 시즌 기준으로 사용자별 주차 인정 상태를 한 화면에서 확인합니다.
          </p>
        </div>
        <AdminHelp />
        <Button variant="outline" onClick={reload} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
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

      {/* 탭 — 기본은 주차 인정 결과, check 기준 관리는 탭 전환으로 노출 */}
      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b">
        {VIEW_TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <span key={tab.key} className="inline-flex items-center gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "relative -mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-sm",
                  isActive
                    ? "border-foreground bg-background font-semibold text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
                )}
              >
                {tab.label}
              </button>
              <AdminHelpIconButton helpKey={tab.helpKey} title={tab.label} size="xs" />
            </span>
          );
        })}
      </div>

      {/* 요약 카드 (주차 인정 결과 탭) — 필터 상태 유지를 위해 unmount 대신 hidden 전환 */}
      <div
        className={cn(
          "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
          activeTab !== "recognitions" && "hidden",
        )}
      >
        <SummaryCard label="전체" value={summary?.total_count ?? null} loading={loading} helpKey="admin.weekRecognitions.stat.total" />
        <SummaryCard label="인정" value={summary?.success_count ?? null} tone="success" loading={loading} helpKey="admin.weekRecognitions.stat.success" />
        <SummaryCard label="미인정" value={summary?.fail_count ?? null} tone="fail" loading={loading} helpKey="admin.weekRecognitions.stat.fail" />
        <SummaryCard label="개인 휴식" value={summary?.personal_rest_count ?? null} tone="rest" loading={loading} helpKey="admin.weekRecognitions.stat.personalRest" />
        <SummaryCard label="공식 휴식" value={summary?.official_rest_count ?? null} tone="official" loading={loading} helpKey="admin.weekRecognitions.stat.officialRest" />
      </div>

      <Card className={cn(activeTab !== "recognitions" && "hidden")}>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            인정 결과 목록
            <AdminHelpIconButton
              helpKey="admin.weekRecognitions.section.resultList"
              title="인정 결과 목록"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            사용자별 주차 인정 상태를 기준으로 시즌·주차 정보와 이름·조직을 조합했습니다.
            {data?.truncated && " (결과가 많아 일부만 표시됩니다.)"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 필터 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1">
              <Select value={seasonKey} onValueChange={(v) => setSeasonKey(v ?? ALL)}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="전체 시즌" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 시즌</SelectItem>
                  {seasons.map((s) => (
                    <SelectItem key={s.season_key} value={s.season_key}>
                      {s.season_label ?? s.season_key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.weekRecognitions.filter.season"
                title="시즌"
                size="xs"
              />
            </div>

            <div className="inline-flex items-center gap-1">
              <Select value={weekId} onValueChange={(v) => setWeekId(v ?? ALL)}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="전체 주차" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 주차</SelectItem>
                  {weekOptions.map((w) => (
                    <SelectItem key={w.week_id} value={w.week_id}>
                      {w.week_label}
                      {w.week_start_date ? ` · ${formatClubDate(w.week_start_date)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.weekRecognitions.filter.week"
                title="주차"
                size="xs"
              />
            </div>

            <div className="inline-flex items-center gap-1">
              <Select value={organization} onValueChange={(v) => setOrganization(v ?? ALL)}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="전체 조직" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 조직</SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {ORGANIZATION_LABEL[slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.weekRecognitions.filter.organization"
                title="조직"
                size="xs"
              />
            </div>

            <div className="inline-flex items-center gap-1">
              <Select value={status} onValueChange={(v) => setStatus(v ?? ALL)}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="전체 상태" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 상태</SelectItem>
                  {WEEK_RECOGNITION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.weekRecognitions.filter.status"
                title="상태"
                size="xs"
              />
            </div>

            <div className="inline-flex items-center gap-1">
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="이름으로 검색"
                  className="pl-8"
                />
              </div>
              <AdminHelpIconButton
                helpKey="admin.weekRecognitions.filter.search"
                title="이름 검색"
                size="xs"
              />
            </div>
          </div>

          {/* 주차 결과 확정: 단일 주차 선택 시에만 노출 */}
          {selectedWeek &&
            (() => {
              const confirmStatus = confirmStatusOf(
                selectedWeek.week_end_date,
                selectedWeek.result_published_at,
              );
              const confirmed = confirmStatus === "확정 완료";
              // 결과 확정은 "집계 중"(종료·미확정) 주차에서만 가능. 진행 중/확정 완료는 비활성.
              const canConfirm = confirmStatus === "집계 중";
              // 검수 완료는 공표(확정 완료) 이후에만 가능 — 미공표/미검수에서만 활성.
              const reviewed = !!selectedWeek.result_reviewed_at;
              const canReview = confirmed && !reviewed;
              return (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {selectedWeek.week_label} 결과 확정
                      </span>
                      <ConfirmStatusBadge
                        endDate={selectedWeek.week_end_date}
                        at={selectedWeek.result_published_at}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {confirmed
                        ? reviewed
                          ? `공표 · ${formatClubDateTime(selectedWeek.result_published_at)} → 검수 완료 · ${formatClubDateTime(selectedWeek.result_reviewed_at)}`
                          : `공표(공표 중) · ${formatClubDateTime(selectedWeek.result_published_at)} — /weekly-ranking 은 "공표 중". 검수 완료 시 "검수 완료"로 전환됩니다.`
                        : confirmStatus === "집계 중"
                          ? '집계 중 — 결과 확정 전. 크루 페이지에서 이 주차는 "성장(집계 중)"으로 표시됩니다.'
                          : "진행 중 — 주차 종료 후 결과를 확정할 수 있습니다."}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => setPublishTarget(selectedWeek)}
                      disabled={!canConfirm}
                    >
                      {confirmed ? "공표 완료" : "이 주차 결과 공표"}
                    </Button>
                    <Button
                      type="button"
                      variant={canReview ? "default" : "ghost"}
                      onClick={() => setReviewTarget(selectedWeek)}
                      disabled={!canReview}
                    >
                      {reviewed ? "검수 완료됨" : "검수 완료"}
                    </Button>
                  </div>
                </div>
              );
            })()}

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>이름</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.name" title="이름" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>조직</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.organization" title="조직" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>시즌</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.season" title="시즌" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>주차</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.week" title="주차" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>기간</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.period" title="기간" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>상태</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.status" title="상태" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>확정</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.confirm" title="확정" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>공식 휴식 인정</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.officialRestOverride" title="공식 휴식 인정" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>메모</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.note" title="메모" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>수정일</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.updatedAt" title="수정일" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>관리</span>
                      <AdminHelpIconButton helpKey="admin.weekRecognitions.column.manage" title="관리" size="xs" />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, idx) => (
                  <TableRow
                    key={`${row.user_id}-${row.week_id ?? row.week_start_date ?? idx}`}
                  >
                    <TableCell className="whitespace-nowrap font-medium">
                      {row.user_name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {orgLabel(row.organization_slug)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.season_label ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium">
                      {row.week_label}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatRange(row.week_start_date, row.week_end_date)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge row={row} />
                    </TableCell>
                    <TableCell>
                      <ConfirmStatusBadge
                        endDate={row.week_end_date}
                        at={row.week_result_published_at}
                      />
                    </TableCell>
                    <TableCell>
                      {row.is_official_rest_override ? (
                        <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                          인정
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground" title={row.note ?? ""}>
                      {row.note?.trim() ? row.note : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.updated_at)}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                      >
                        수정
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={11}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 주차 인정 결과가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && rows.length === 0 && (
                  <TableSkeletonRows columns={11} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-xs text-muted-foreground">
            {loading ? (
              <LoadingState active variant="inline" />
            ) : (
              `${rows.length.toLocaleString()}건`
            )}
          </div>
        </CardContent>
      </Card>

      {/* check 기준 관리 탭 — 수정 중 입력 유지를 위해 hidden 전환 */}
      <div className={cn(activeTab !== "check_threshold" && "hidden")}>
        <CheckThresholdManager
          weeks={weekOptions}
          seasons={seasons}
          loading={loading}
          onSaved={(message) => {
            setBanner({ kind: "success", message });
            setRefreshTick((n) => n + 1);
          }}
          onError={(message) => setBanner({ kind: "error", message })}
        />
      </div>

      {editing && (
        <WeekRecognitionEditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}

      {publishTarget && (
        <PublishWeekModal
          week={publishTarget}
          onClose={() => setPublishTarget(null)}
          onPublished={handlePublished}
        />
      )}

      {reviewTarget && (
        <ReviewWeekModal
          week={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onReviewed={handleReviewed}
        />
      )}
    </div>
  );
}

// 검수 완료 모달 — 공표된 주차의 weeks.result_reviewed_at 을 세팅한다(PublishWeekModal 미러).
//   개인 카드/스냅샷 무영향 — /weekly-ranking 라벨만 '공표 중' → '검수 완료'.
function ReviewWeekModal({
  week,
  onClose,
  onReviewed,
}: {
  week: WeekRecognitionWeekOption;
  onClose: () => void;
  onReviewed: (label: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = readScopeMode(useSearchParams());

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/weeks/${encodeURIComponent(week.week_id)}/review-result`,
          mode,
        ),
        { method: "PATCH" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to mark week result reviewed.");
      }
      onReviewed(week.week_label);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to mark week result reviewed.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="주차 검수 완료"
        className="modal-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">주차 검수 완료</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="닫기"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          <div className="font-medium">{week.week_label}</div>
          <div className="text-xs text-muted-foreground">
            {formatRange(week.week_start_date, week.week_end_date)}
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          이 주차를 검수 완료하면 크루 <code>/weekly-ranking</code> 카드가
          {' "공표 중"에서 "검수 완료"로 전환됩니다. '}
          개인 주차 카드/집계 수치는 변하지 않으며(검수 완료는 랭킹 라벨 신호), 검수 완료는 취소할 수
          없습니다.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button type="button" onClick={submit} loading={saving}>
            검수 완료
          </Button>
        </div>
      </div>
    </div>
  );
}

function PublishWeekModal({
  week,
  onClose,
  onPublished,
}: {
  week: WeekRecognitionWeekOption;
  onClose: () => void;
  onPublished: (label: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = readScopeMode(useSearchParams());

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/weeks/${encodeURIComponent(week.week_id)}/publish-result`,
          mode,
        ),
        { method: "PATCH" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to publish week result.");
      }
      onPublished(week.week_label);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to publish week result.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="주차 결과 확정"
        className="modal-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">주차 결과 확정</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="닫기"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          <div className="font-medium">{week.week_label}</div>
          <div className="text-xs text-muted-foreground">
            {formatRange(week.week_start_date, week.week_end_date)}
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          이 주차 결과를 확정하면 크루 페이지에서 해당 주차 카드가
          {' "성장(집계 중)"에서 사용자별 성공/실패 상태로 전환됩니다. '}
          사용자별 인정 상태(성공/실패/휴식) 자체는 변경되지 않으며, 결과 확정은 취소할 수
          없습니다.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button type="button" onClick={submit} loading={saving}>
            결과 확정
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── 주차 인정 check 기준 관리 ────────────────────────────────────────
// 주차별 "주차 인정 point.check 기준값"(weeks.check_threshold) 표시/수정.
//   - 주차 성공 판정에는 point.check 만 사용 (advantage/penalty 미사용).
//   - 기준값 없음(null) = 기본값(DEFAULT_WEEK_CHECK_THRESHOLD=30) 적용 — "기본값" 배지로 표시.
//   - 레거시(2026 여름 W1 이전) 통합 라인 주차 판정에 적용: 평점 ≥4(강화 성공) AND
//     check >= 기준값이어야 주차 성공.
//   - 노출은 상단 "check 기준 관리" 탭으로 제어(인정 결과 목록과 동시 노출 안 함).

function CheckThresholdManager({
  weeks,
  seasons,
  loading,
  onSaved,
  onError,
}: {
  weeks: WeekRecognitionWeekOption[];
  seasons: { season_key: string; season_label: string | null }[];
  loading: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const seasonLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of seasons) m.set(s.season_key, s.season_label ?? s.season_key);
    return m;
  }, [seasons]);

  return (
    <Card id="check-threshold">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1.5 text-base">
          주차 인정 체크 기준 관리
          <AdminHelpIconButton
            helpKey="admin.weekRecognitions.section.checkThreshold"
            title="주차 인정 체크 기준 관리"
            size="sm"
          />
        </CardTitle>
        <CardDescription>
          주차 성공 판정에 필요한 체크 개수 기준입니다. 주차 성공 = [실무 경험]
          통합 라인 평점 4점 이상(강화 성공) <span className="font-medium">그리고</span> 체크
          획득 수가 이 기준 이상. 가산점 / 감점은 판정에 사용하지 않습니다.
          비워 두면 기본값 {DEFAULT_WEEK_CHECK_THRESHOLD}개가 적용됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>시즌</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.season" title="시즌" size="xs" />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>주차</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.week" title="주차" size="xs" />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>기간</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.period" title="기간" size="xs" />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>공표 상태</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.publishStatus" title="공표 상태" size="xs" />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>check 인정 기준</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.threshold" title="check 인정 기준" size="xs" />
                  </span>
                </TableHead>
                <TableHead className="w-56">
                  <span className="inline-flex items-center gap-1">
                    <span>수정</span>
                    <AdminHelpIconButton helpKey="admin.weekRecognitions.checkThreshold.column.edit" title="수정" size="xs" />
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((w) => (
                <CheckThresholdRow
                  key={w.week_id}
                  week={w}
                  seasonLabel={
                    w.season_key
                      ? seasonLabelByKey.get(w.season_key) ?? w.season_key
                      : "—"
                  }
                  onSaved={onSaved}
                  onError={onError}
                />
              ))}
              {!loading && weeks.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-muted-foreground"
                  >
                    표시할 주차가 없습니다.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function CheckThresholdRow({
  week,
  seasonLabel,
  onSaved,
  onError,
}: {
  week: WeekRecognitionWeekOption;
  seasonLabel: string;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  // 입력값: "" = 기본값 사용(null 저장). 주차 옵션이 갱신되면 동기화.
  const [value, setValue] = useState<string>(
    week.check_threshold == null ? "" : String(week.check_threshold),
  );
  const [saving, setSaving] = useState(false);
  const mode = readScopeMode(useSearchParams());

  useEffect(() => {
    setValue(week.check_threshold == null ? "" : String(week.check_threshold));
  }, [week.check_threshold, week.week_id]);

  const trimmed = value.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const invalid =
    parsed !== null &&
    (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000);
  const dirty =
    (parsed === null ? null : parsed) !== (week.check_threshold ?? null);

  const save = async () => {
    if (saving || invalid || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/weeks/${encodeURIComponent(week.week_id)}/check-threshold`,
          mode,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ check_threshold: parsed }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "체크 인정 기준 저장에 실패했습니다.");
      }
      const d = json.data as {
        week_label: string;
        effective_check_threshold: number;
        check_threshold_is_default: boolean;
        snapshot_recompute?: { requested: number; recomputed: number };
      };
      const snap = d.snapshot_recompute
        ? ` (카드 정보 ${d.snapshot_recompute.recomputed}/${d.snapshot_recompute.requested}명 업데이트)`
        : "";
      onSaved(
        `${seasonLabel} ${d.week_label} 체크 인정 기준을 ${
          d.check_threshold_is_default
            ? `기본값(${d.effective_check_threshold}개)`
            : `${d.effective_check_threshold}개`
        }로 저장했습니다.${snap}`,
      );
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "체크 인정 기준 저장에 실패했습니다.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{seasonLabel}</TableCell>
      <TableCell className="whitespace-nowrap font-medium">
        {week.week_label}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatRange(week.week_start_date, week.week_end_date)}
      </TableCell>
      <TableCell>
        <ConfirmStatusBadge
          endDate={week.week_end_date}
          at={week.result_published_at}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="font-medium tabular-nums">
          {week.effective_check_threshold}개
        </span>
        {week.check_threshold_is_default && (
          <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            기본값
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={`기본 ${DEFAULT_WEEK_CHECK_THRESHOLD}`}
            inputMode="numeric"
            className={cn("h-8 w-24", invalid && "border-red-400")}
            aria-label={`${seasonLabel} ${week.week_label} check 인정 기준`}
          />
          <Button
            type="button"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={invalid || !dirty}
          >
            저장
          </Button>
        </div>
        {invalid && (
          <div className="mt-1 text-xs text-red-600">
            0 이상 10000 이하 정수만 가능합니다.
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function WeekRecognitionEditModal({
  row,
  onClose,
  onSaved,
}: {
  row: WeekRecognitionRow;
  onClose: () => void;
  onSaved: (updatedName: string | null, recalcSkipped: boolean) => void;
}) {
  const [status, setStatus] = useState<WeekRecognitionStatus>(
    (WEEK_RECOGNITION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as WeekRecognitionStatus)
      : "success",
  );
  const [note, setNote] = useState(row.note ?? "");
  const [override, setOverride] = useState(row.is_official_rest_override);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = readScopeMode(useSearchParams());

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/week-recognitions/${encodeURIComponent(
            row.user_week_status_id,
          )}`,
          mode,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            note: note.trim() ? note : null,
            is_official_rest_override: override,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to update week recognition.");
      }
      onSaved(row.user_name, json.data?.recalculation_skipped === true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update week recognition.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="주차 상태 수정"
        className="modal-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">주차 상태 수정</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="닫기"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          <div className="font-medium">{row.user_name ?? "—"}</div>
          <div className="text-xs text-muted-foreground">
            {(row.season_label ?? "—") + " · " + row.week_label}
            {row.week_start_date ? ` · ${formatClubDate(row.week_start_date)}` : ""}
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-sm font-medium">
              상태
              <AdminHelpIconButton helpKey="admin.weekRecognitions.field.status" title="상태" size="xs" />
            </span>
            <Select
              value={status}
              onValueChange={(v) =>
                setStatus((v as WeekRecognitionStatus) ?? status)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEK_RECOGNITION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {statusLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-sm font-medium">
              메모
              <AdminHelpIconButton helpKey="admin.weekRecognitions.field.note" title="메모" size="xs" />
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="메모 (선택)"
              className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <div className="inline-flex items-center gap-1">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={override}
                onChange={(event) => setOverride(event.target.checked)}
              />
              공식 휴식 인정 override
            </label>
            <AdminHelpIconButton helpKey="admin.weekRecognitions.field.officialRestOverride" title="공식 휴식 인정" size="xs" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={saving}
          >
            취소
          </Button>
          <Button type="button" onClick={submit} loading={saving}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}
