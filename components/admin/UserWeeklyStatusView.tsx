"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import { pointColorClass } from "@/components/ui/point-value";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import type {
  UserWeeklyStatusDto,
  UserWeeklyStatusRow,
} from "@/lib/adminUserWeeklyStatusTypes";
import { formatClubDate } from "@/lib/clubDate";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return formatClubDate(value);
}

function formatRange(start: string | null, end: string | null) {
  if (!start && !end) return "-";
  if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`;
  return formatDate(start ?? end);
}

const STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
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

function StatusBadge({ row }: { row: UserWeeklyStatusRow }) {
  const meta = STATUS_META[row.status] ?? {
    label: row.status || "미상",
    className: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
      {row.is_official_rest_override && (
        <span
          title="공식 휴식이지만 활동이 인정된 주차"
          className="rounded-sm bg-amber-200/70 px-1 text-[10px] font-semibold text-amber-900"
        >
          인정
        </span>
      )}
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
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {label}
          {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />}
        </span>
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

export default function UserWeeklyStatusView({
  userId,
}: {
  userId: string;
}) {
  const [data, setData] = useState<UserWeeklyStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/users/${encodeURIComponent(userId)}/weekly-status`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load weekly status.");
        }
        if (!cancelled) setData(json.data as UserWeeklyStatusDto);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load weekly status.",
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
  }, [userId, refreshTick]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold tracking-tight">주차 상태</h2>
          <p className="text-sm text-muted-foreground">
            사용자의 시즌·주차별 인정 상태와 포인트·평판·동료 참고값을 조회합니다.
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {userId}
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <SummaryCard label="전체 주차" value={summary?.total_weeks ?? null} loading={loading} helpKey="admin.members.weeklyStatus.stat.totalWeeks" />
        <SummaryCard label="성공 주차" value={summary?.success_weeks ?? null} tone="success" loading={loading} helpKey="admin.members.weeklyStatus.stat.successWeeks" />
        <SummaryCard label="실패 주차" value={summary?.fail_weeks ?? null} tone="fail" loading={loading} helpKey="admin.members.weeklyStatus.stat.failWeeks" />
        <SummaryCard label="개인 휴식" value={summary?.personal_rest_weeks ?? null} tone="rest" loading={loading} helpKey="admin.members.weeklyStatus.stat.personalRestWeeks" />
        <SummaryCard label="공식 휴식" value={summary?.official_rest_weeks ?? null} tone="official" loading={loading} helpKey="admin.members.weeklyStatus.stat.officialRestWeeks" />
        <SummaryCard label="승인 주차" value={summary?.approved_weeks ?? null} loading={loading} helpKey="admin.members.weeklyStatus.stat.approvedWeeks" />
        <SummaryCard label="누적 주차" value={summary?.cumulative_weeks ?? null} loading={loading} helpKey="admin.members.weeklyStatus.stat.cumulativeWeeks" />
      </div>

      {/* 주차별 테이블 */}
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            주차별 상태
            <AdminHelpIconButton
              helpKey="admin.members.weeklyStatus.section.weeklyTable"
              title="주차별 상태"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            사용자별 주차 인정 상태를 기준으로 시즌·주차 정보와 포인트·평판·동료 값을 조합했습니다.
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
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.season" title="시즌" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>주차</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.week" title="주차" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>주차 기간</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.period" title="주차 기간" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>상태</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.status" title="상태" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead title="별 개수 = 획득한 체크 수">
                    <span className="inline-flex items-center gap-1">
                      <span>Check</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.check" title="Check" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead
                    title="받은 방패 원본값 — 내부 집계/검증 전용, 크루 화면에는 노출되지 않습니다."
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>Advantage (Raw)</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.advantageRaw" title="Advantage (Raw)" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead
                    title="포인트 C(패널티) 값 — 크루 화면에는 포인트 C(빨간색, 양수)로 표시됩니다."
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>Penalty</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.penalty" title="Penalty" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead
                    title="크루 화면 표시 방패 = Advantage(Raw) − Penalty. 크루 화면에 쓰이는 값은 이 값입니다."
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>Net Advantage</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.netAdvantage" title="Net Advantage" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>평판</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.reputation" title="평판" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>동료 수</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.colleagueCount" title="동료 수" size="xs" />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>실패 사유</span>
                      <AdminHelpIconButton helpKey="admin.members.weeklyStatus.column.failureReason" title="실패 사유" size="xs" />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, idx) => (
                  <TableRow key={row.week_id ?? `${row.week_start_date}-${idx}`}>
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
                    <TableCell className={cn("tabular-nums", pointColorClass("a"))}>
                      {row.weekly_star_count.toLocaleString()}
                    </TableCell>
                    <TableCell
                      title="원본값 — 내부 전용, 크루 화면 미노출"
                      className={cn("tabular-nums", pointColorClass("b"))}
                    >
                      {row.weekly_shield_count.toLocaleString()}
                    </TableCell>
                    <TableCell
                      title={`크루 화면 표시 포인트 C: ${row.weekly_lightning_count}`}
                      className={cn("tabular-nums", pointColorClass("c"))}
                    >
                      {row.weekly_lightning_count.toLocaleString()}
                    </TableCell>
                    <TableCell
                      title="크루 화면 표시 방패 = Advantage(Raw) − Penalty"
                      className={cn("font-medium tabular-nums", pointColorClass("b"))}
                    >
                      {row.weekly_net_shield_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.reputation_score != null
                        ? `${row.reputation_score} (${row.weekly_reputation_count})`
                        : row.weekly_reputation_count > 0
                          ? `(${row.weekly_reputation_count})`
                          : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.colleague_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {row.failure_reason ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={11}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 주차 상태가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && rows.length === 0 && (
                  <TableSkeletonRows columns={11} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
