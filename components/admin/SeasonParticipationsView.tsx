"use client";

import { useCallback, useEffect, useState } from "react";
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
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import {
  ORGANIZATIONS,
  organizationLabelKo,
} from "@/lib/organizations";
import {
  SEASON_PARTICIPATION_STATUSES,
  type SeasonParticipationRow,
  type SeasonParticipationsDto,
  type SeasonParticipationStatus,
  type SeasonPhase,
} from "@/lib/adminSeasonParticipationsTypes";
import { formatClubDate } from "@/lib/clubDate";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { useActionToast } from "@/lib/actionToast";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

const ALL = "__all__";

// user_season_statuses.status 원본값(success/rest/stopped) 필터 라벨.
const STATUS_FILTER_LABEL: Record<string, string> = {
  success: "참여(인정)",
  active: "활동/참여",
  rest: "휴식",
  stopped: "중단",
};

// 파생 분류(season_phase) 배지 — 요약 카드와 동일 분류.
const PHASE_META: Record<SeasonPhase, { label: string; className: string }> = {
  active: {
    label: "참여 중",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  rest: {
    label: "휴식",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  stopped: {
    label: "중단",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
  completed: {
    label: "완료",
    className: "border-violet-200 bg-violet-50 text-violet-700",
  },
  unknown: {
    label: "미확인",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return formatClubDate(value);
}

function formatRange(start: string | null, end: string | null) {
  if (!start && !end) return "-";
  if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`;
  return formatDate(start ?? end);
}

// updated_at 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function formatDateTime(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "—" });
}

// 조직 표시명 = lib/organizations 단일 SoT(null=공통 · 미인식 slug=원문).
function orgLabel(slug: string | null | undefined) {
  return organizationLabelKo(slug);
}

function PhaseBadge({ row }: { row: SeasonParticipationRow }) {
  const meta = PHASE_META[row.season_phase] ?? PHASE_META.unknown;
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

function SummaryCard({
  label,
  value,
  tone = "default",
  loading,
  helpKey,
}: {
  label: string;
  value: number | null;
  tone?: "default" | "active" | "rest" | "stopped" | "completed" | "unknown";
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
            tone === "active" && "text-emerald-600",
            tone === "rest" && "text-sky-600",
            tone === "stopped" && "text-rose-600",
            tone === "completed" && "text-violet-600",
            tone === "unknown" && "text-muted-foreground",
          )}
        >
          {loading ? "…" : value == null ? "—" : value.toLocaleString()}
        </span>
      </CardContent>
    </Card>
  );
}

export default function SeasonParticipationsView() {
  const [data, setData] = useState<SeasonParticipationsDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // QA 모드(?mode=test) — 조회/쓰기에 전파해야 백엔드 scope(테스트 유저만)와 정합(누수 차단).
  const mode = readScopeMode(useSearchParams());

  const [seasonKey, setSeasonKey] = useState<string>(ALL);
  const [organization, setOrganization] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [editing, setEditing] = useState<SeasonParticipationRow | null>(null);
  // 시즌 상태 수정 결과는 하단 공통 토스트로 안내한다.
  //   데이터 조회 실패(error)는 지속 상태이므로 아래 인라인 배너로 유지.
  const t = useActionToast();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (seasonKey !== ALL) params.set("season_key", seasonKey);
      if (organization !== ALL) params.set("organization_slug", organization);
      if (status !== ALL) params.set("status", status);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (mode === "test") params.set("mode", "test");

      try {
        const res = await fetch(
          `/api/admin/season-participations?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "시즌 참여 정보를 불러오지 못했습니다.");
        }
        if (!cancelled) setData(json.data as SeasonParticipationsDto);
      } catch (err) {
        if (!cancelled) {
          console.error("[season-participations] load failed", err);
          setError(getApiErrorMessage(err, "시즌 참여 정보를 불러오지 못했습니다."));
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
  }, [seasonKey, organization, status, debouncedSearch, refreshTick, mode]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const handleSaved = useCallback((_updatedName: string | null) => {
    setEditing(null);
    // 내부 스키마명(user_week_statuses)은 관리자 UI 에 노출하지 않는다 — 결과 + 유의사항만 간결히.
    t.success(
      "update",
      "시즌 상태를 수정했습니다. 주차 상태는 자동으로 변경되지 않습니다.",
    );
    // 현재 필터 조건 그대로 목록 재조회.
    setRefreshTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seasons = data?.seasons ?? [];
  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div className="admin-section-stack-lg">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold tracking-tight">시즌 참여/휴식</h2>
          <p className="text-sm text-muted-foreground">
            시즌별 참여·휴식 상태와 해당 시즌의 주차 상태 구성을 한 화면에서 확인합니다.
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

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard label="전체" value={summary?.total_count ?? null} loading={loading} helpKey="admin.seasonParticipations.stat.total" />
        <SummaryCard label="참여 중" value={summary?.active_count ?? null} tone="active" loading={loading} helpKey="admin.seasonParticipations.stat.active" />
        <SummaryCard label="휴식" value={summary?.rest_count ?? null} tone="rest" loading={loading} helpKey="admin.seasonParticipations.stat.rest" />
        <SummaryCard label="중단" value={summary?.stopped_count ?? null} tone="stopped" loading={loading} helpKey="admin.seasonParticipations.stat.stopped" />
        <SummaryCard label="완료" value={summary?.completed_count ?? null} tone="completed" loading={loading} helpKey="admin.seasonParticipations.stat.completed" />
        <SummaryCard label="기타/미확인" value={summary?.unknown_count ?? null} tone="unknown" loading={loading} helpKey="admin.seasonParticipations.stat.unknown" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            시즌 참여 목록
            <AdminHelpIconButton
              helpKey="admin.seasonParticipations.section.list"
              title="시즌 참여 목록"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            user_season_statuses 를 기준으로 시즌 정보·이름·클럽과 시즌별 주차 상태 집계를 조합했습니다.
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
                helpKey="admin.seasonParticipations.filter.season"
                title="시즌"
                size="xs"
              />
            </div>

            <div className="inline-flex items-center gap-1">
              <Select value={organization} onValueChange={(v) => setOrganization(v ?? ALL)}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="전체 클럽" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 클럽</SelectItem>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {organizationLabelKo(slug)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey={ADMIN_SHARED_HELP_KEYS.crew.organization}
                title="클럽"
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
                  {SEASON_PARTICIPATION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_FILTER_LABEL[s] ?? s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.seasonParticipations.filter.status"
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
                helpKey="admin.seasonParticipations.filter.search"
                title="이름 검색"
                size="xs"
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>이름</span>
                      <AdminHelpIconButton helpKey={ADMIN_SHARED_HELP_KEYS.crew.name} title="이름" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>클럽</span>
                      <AdminHelpIconButton helpKey={ADMIN_SHARED_HELP_KEYS.crew.organization} title="클럽" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>시즌</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.season" title="시즌" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>시즌 기간</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.seasonPeriod" title="시즌 기간" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>시즌 상태</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.seasonStatus" title="시즌 상태" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>성공 주차</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.successWeeks" title="성공 주차" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>실패 주차</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.failWeeks" title="실패 주차" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>개인 휴식</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.personalRestWeeks" title="개인 휴식" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>공식 휴식</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.officialRestWeeks" title="공식 휴식" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>메모</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.note" title="메모" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>수정일</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.updatedAt" title="수정일" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>관리</span>
                      <AdminHelpIconButton helpKey="admin.seasonParticipations.column.manage" title="관리" size="xs" />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, idx) => (
                  <TableRow
                    key={`${row.user_id}-${row.season_key ?? idx}`}
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
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatRange(row.season_start_date, row.season_end_date)}
                    </TableCell>
                    <TableCell>
                      <PhaseBadge row={row} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.success_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.fail_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.personal_rest_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.official_rest_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={row.note ?? ""}>
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
                      colSpan={12}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 시즌 참여/휴식 상태가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && rows.length === 0 && (
                  <TableSkeletonRows columns={12} rows={6} />
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

      {editing && (
        <SeasonParticipationEditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

function SeasonParticipationEditModal({
  row,
  onClose,
  onSaved,
}: {
  row: SeasonParticipationRow;
  onClose: () => void;
  onSaved: (updatedName: string | null) => void;
}) {
  const [status, setStatus] = useState<SeasonParticipationStatus>(
    (SEASON_PARTICIPATION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as SeasonParticipationStatus)
      : "success",
  );
  const [note, setNote] = useState(row.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = readScopeMode(useSearchParams()); // QA 쓰기 스코프 전파(실사용자 write 차단)

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/season-participations/${encodeURIComponent(
            row.user_season_status_id,
          )}`,
          mode,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            note: note.trim() ? note : null,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "시즌 참여 정보를 저장하지 못했습니다.");
      }
      onSaved(row.user_name);
    } catch (err) {
      console.error("[season-participations] save failed", err);
      setError(getApiErrorMessage(err, "시즌 참여 정보를 저장하지 못했습니다."));
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
        aria-label="시즌 상태 수정"
        className="modal-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">시즌 상태 수정</h2>
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
            {(row.season_label ?? row.season_key ?? "—") +
              " · " +
              orgLabel(row.organization_slug)}
          </div>
        </div>

        <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          시즌 상태(success/rest)만 수정됩니다. 주차 상태(user_week_statuses)는
          자동으로 변경되지 않습니다.
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
              <AdminHelpIconButton helpKey="admin.seasonParticipations.field.status" title="상태" size="xs" />
            </span>
            <Select
              value={status}
              onValueChange={(v) =>
                setStatus((v as SeasonParticipationStatus) ?? status)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEASON_PARTICIPATION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_FILTER_LABEL[s] ?? s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-sm font-medium">
              메모
              <AdminHelpIconButton helpKey="admin.seasonParticipations.field.note" title="메모" size="xs" />
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="메모 (선택)"
              className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
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
