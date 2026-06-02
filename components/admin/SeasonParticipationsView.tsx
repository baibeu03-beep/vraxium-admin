"use client";

import { useCallback, useEffect, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  ORGANIZATIONS,
  ORGANIZATION_COMMON_LABEL,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import {
  SEASON_PARTICIPATION_STATUSES,
  type SeasonParticipationRow,
  type SeasonParticipationsDto,
  type SeasonParticipationStatus,
  type SeasonPhase,
} from "@/lib/adminSeasonParticipationsTypes";

const ALL = "__all__";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

type Banner = { kind: "success" | "error"; message: string } | null;

// user_season_statuses.status 원본값(success/rest) 필터 라벨.
const STATUS_FILTER_LABEL: Record<string, string> = {
  success: "참여(인정)",
  rest: "휴식",
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
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return `${value}(${WEEKDAYS[date.getUTCDay()]})`;
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
}: {
  label: string;
  value: number | null;
  tone?: "default" | "active" | "rest" | "completed" | "unknown";
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone === "active" && "text-emerald-600",
            tone === "rest" && "text-sky-600",
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
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [seasonKey, setSeasonKey] = useState<string>(ALL);
  const [organization, setOrganization] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [editing, setEditing] = useState<SeasonParticipationRow | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 6000);
    return () => window.clearTimeout(t);
  }, [banner]);

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

      try {
        const res = await fetch(
          `/api/admin/season-participations?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load season participations.");
        }
        if (!cancelled) setData(json.data as SeasonParticipationsDto);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load season participations.",
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
  }, [seasonKey, organization, status, debouncedSearch, refreshTick]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const handleSaved = useCallback((updatedName: string | null) => {
    setEditing(null);
    setBanner({
      kind: "success",
      message: `${updatedName ?? "사용자"} 시즌 상태만 수정되었고, 주차 상태(user_week_statuses)는 자동 변경되지 않았습니다.`,
    });
    // 현재 필터 조건 그대로 목록 재조회.
    setRefreshTick((n) => n + 1);
  }, []);

  const seasons = data?.seasons ?? [];
  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">시즌 참여/휴식</h2>
          <p className="text-sm text-muted-foreground">
            시즌별 참여·휴식 상태와 해당 시즌의 주차 상태 구성을 한 화면에서 확인합니다.
          </p>
        </div>
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

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="전체" value={summary?.total_count ?? null} loading={loading} />
        <SummaryCard label="참여 중" value={summary?.active_count ?? null} tone="active" loading={loading} />
        <SummaryCard label="휴식" value={summary?.rest_count ?? null} tone="rest" loading={loading} />
        <SummaryCard label="완료" value={summary?.completed_count ?? null} tone="completed" loading={loading} />
        <SummaryCard label="기타/미확인" value={summary?.unknown_count ?? null} tone="unknown" loading={loading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">시즌 참여 목록</CardTitle>
          <CardDescription>
            user_season_statuses 를 기준으로 시즌 정보·이름·조직과 시즌별 주차 상태 집계를 조합했습니다.
            {data?.truncated && " (결과가 많아 일부만 표시됩니다.)"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 필터 */}
          <div className="flex flex-wrap items-center gap-2">
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

            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="이름으로 검색"
                className="pl-8"
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>조직</TableHead>
                  <TableHead>시즌</TableHead>
                  <TableHead>시즌 기간</TableHead>
                  <TableHead>시즌 상태</TableHead>
                  <TableHead className="text-right">성공 주차</TableHead>
                  <TableHead className="text-right">실패 주차</TableHead>
                  <TableHead className="text-right">개인 휴식</TableHead>
                  <TableHead className="text-right">공식 휴식</TableHead>
                  <TableHead>메모</TableHead>
                  <TableHead>수정일</TableHead>
                  <TableHead className="text-right">관리</TableHead>
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
                    <TableCell className="text-right tabular-nums">
                      {row.success_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.fail_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.personal_rest_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.official_rest_weeks.toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={row.note ?? ""}>
                      {row.note?.trim() ? row.note : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
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
                  <TableRow>
                    <TableCell
                      colSpan={12}
                      className="py-10 text-center text-muted-foreground"
                    >
                      불러오는 중...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-xs text-muted-foreground">
            {loading ? "불러오는 중..." : `${rows.length.toLocaleString()}건`}
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

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/season-participations/${encodeURIComponent(
          row.user_season_status_id,
        )}`,
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
        throw new Error(json?.error ?? "Failed to update season participation.");
      }
      onSaved(row.user_name);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update season participation.",
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
        aria-label="시즌 상태 수정"
        className="w-full max-w-md rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
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
            <span className="text-sm font-medium">상태</span>
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
            <span className="text-sm font-medium">메모</span>
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
          <Button type="button" onClick={submit} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </Button>
        </div>
      </div>
    </div>
  );
}
