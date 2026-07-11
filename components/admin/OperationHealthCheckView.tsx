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
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  ORGANIZATION_COMMON_LABEL,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import {
  HEALTH_ISSUE_TYPE_META,
  type HealthIssue,
  type HealthIssueSeverity,
  type OperationHealthCheckDto,
  type RecalcGrowthStatsResult,
} from "@/lib/adminOperationHealthCheckTypes";

type Banner = { kind: "success" | "error"; message: string } | null;

// 성장 통계 캐시(user_growth_stats)만 복구 가능한 이슈 유형.
const GROWTH_RECALC_ISSUE_TYPES = new Set<HealthIssue["issue_type"]>([
  "growth_approved_mismatch",
  "growth_cumulative_mismatch",
]);

const RECALC_ENDPOINT =
  "/api/admin/operation-health-check/recalculate-growth-stats";

const SEVERITY_META: Record<
  HealthIssueSeverity,
  { label: string; className: string }
> = {
  error: {
    label: "오류",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  warning: {
    label: "경고",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

function orgLabel(slug: string | null | undefined) {
  if (!slug) return ORGANIZATION_COMMON_LABEL;
  if (isOrganizationSlug(slug)) return ORGANIZATION_LABEL[slug];
  return slug;
}

function issueTypeLabel(issueType: HealthIssue["issue_type"]) {
  return HEALTH_ISSUE_TYPE_META[issueType]?.label ?? issueType;
}

function SeverityBadge({ severity }: { severity: HealthIssueSeverity }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.warning;
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
  tone?: "default" | "total" | "warning" | "error";
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
            tone === "total" && value != null && value > 0 && "text-foreground",
            tone === "warning" && value != null && value > 0 && "text-amber-600",
            tone === "error" && value != null && value > 0 && "text-red-600",
          )}
        >
          {loading ? "…" : value == null ? "—" : value.toLocaleString()}
        </span>
      </CardContent>
    </Card>
  );
}

export default function OperationHealthCheckView() {
  const [data, setData] = useState<OperationHealthCheckDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [banner, setBanner] = useState<Banner>(null);
  // 재집계 진행 중인 키: 단건이면 user_id, 전체면 "__all__". 없으면 null.
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 6000);
    return () => window.clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/operation-health-check", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to run operation health check.");
        }
        if (!cancelled) setData(json.data as OperationHealthCheckDto);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to run operation health check.",
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
  }, [refreshTick]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  const runRecalc = useCallback(
    async (mode: "single" | "all_mismatched", userId?: string) => {
      if (processing) return;
      const key = mode === "all_mismatched" ? "__all__" : userId ?? "";
      setProcessing(key);
      setBanner(null);
      try {
        const res = await fetch(RECALC_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "single" ? { mode, user_id: userId } : { mode },
          ),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to recalculate growth stats.");
        }
        const result = json.data as RecalcGrowthStatsResult;
        const parts = [`성공 ${result.processed_count}건`];
        if (result.failed_count > 0) parts.push(`실패 ${result.failed_count}건`);
        if (result.skipped_count > 0)
          parts.push(`미처리 ${result.skipped_count}건(100명 초과)`);
        setBanner({
          kind:
            result.failed_count > 0 || result.skipped_count > 0
              ? "error"
              : "success",
          message: `성장 통계 재집계 완료 — ${parts.join(", ")}.`,
        });
        // 처리 후 현재 목록 재조회.
        setRefreshTick((n) => n + 1);
      } catch (err) {
        setBanner({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Failed to recalculate growth stats.",
        });
      } finally {
        setProcessing(null);
      }
    },
    [processing],
  );

  const summary = data?.summary;
  const issues = data?.issues ?? [];
  const growthMismatchCount = summary?.growth_stats_mismatch_count ?? 0;
  const busy = processing !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">운영 정합성 점검</h2>
          <p className="text-sm text-muted-foreground">
            시즌·주차·성장 통계 관련 데이터 정합성 문제를 한 화면에서 진단합니다. (조회 전용)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminHelp />
          <Button
            variant="outline"
            onClick={() => runRecalc("all_mismatched")}
            disabled={loading || busy || growthMismatchCount === 0}
            title={
              growthMismatchCount === 0
                ? "성장 통계 불일치 이슈가 없습니다."
                : undefined
            }
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                processing === "__all__" && "animate-spin",
              )}
            />
            성장 통계 불일치 전체 재집계
          </Button>
          <Button variant="outline" onClick={reload} disabled={loading || busy}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            다시 점검
          </Button>
        </div>
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
        <SummaryCard
          label="전체 이슈"
          value={summary?.total_issues ?? null}
          tone="total"
          loading={loading}
          helpKey="admin.operationHealthCheck.stat.totalIssues"
        />
        <SummaryCard
          label="성장 통계 불일치"
          value={summary?.growth_stats_mismatch_count ?? null}
          tone="warning"
          loading={loading}
          helpKey="admin.operationHealthCheck.stat.growthStatsMismatch"
        />
        <SummaryCard
          label="시즌 휴식 불일치"
          value={summary?.season_rest_mismatch_count ?? null}
          tone="warning"
          loading={loading}
          helpKey="admin.operationHealthCheck.stat.seasonRestMismatch"
        />
        <SummaryCard
          label="시즌 key 불일치"
          value={summary?.season_key_mismatch_count ?? null}
          tone="error"
          loading={loading}
          helpKey="admin.operationHealthCheck.stat.seasonKeyMismatch"
        />
        <SummaryCard
          label="주차 매핑 불일치"
          value={summary?.week_mapping_mismatch_count ?? null}
          tone="error"
          loading={loading}
          helpKey="admin.operationHealthCheck.stat.weekMappingMismatch"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            정합성 이슈 목록
            <AdminHelpIconButton
              helpKey="admin.operationHealthCheck.section.issueList"
              title="정합성 이슈 목록"
              size="sm"
            />
          </CardTitle>
          <CardDescription>
            성장 통계 · 주차 인정 상태 · 시즌 상태 · 주차 · 시즌 정의 데이터를 대조해
            발견한 정합성 문제입니다. 자동 수정은 제공하지
            않습니다.
            {data?.truncated &&
              ` (이슈가 많아 처음 ${issues.length.toLocaleString()}건만 표시합니다.)`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>심각도</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.severity"
                        title="심각도"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>이슈 유형</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.issueType"
                        title="이슈 유형"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>사용자</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.user"
                        title="사용자"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>조직</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.organization"
                        title="조직"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>시즌</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.season"
                        title="시즌"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>주차</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.week"
                        title="주차"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>메시지</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.message"
                        title="메시지"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>기대값</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.expected"
                        title="기대값"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>실제값</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.actual"
                        title="실제값"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      <span>관리</span>
                      <AdminHelpIconButton
                        helpKey="admin.operationHealthCheck.column.manage"
                        title="관리"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map((issue, idx) => (
                  <TableRow key={`${issue.issue_type}-${issue.user_id ?? issue.week_id ?? idx}-${idx}`}>
                    <TableCell>
                      <SeverityBadge severity={issue.severity} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium">
                      {issueTypeLabel(issue.issue_type)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {issue.user_name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {issue.user_id ? orgLabel(issue.organization_slug) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {issue.season_key ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {issue.week_id ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[320px] text-xs text-muted-foreground">
                      {issue.message}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {issue.expected_value ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {issue.actual_value ?? "—"}
                    </TableCell>
                    <TableCell>
                      {GROWTH_RECALC_ISSUE_TYPES.has(issue.issue_type) &&
                      issue.user_id ? (
                        <button
                          type="button"
                          onClick={() => runRecalc("single", issue.user_id!)}
                          disabled={busy}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {processing === issue.user_id
                            ? "재집계 중..."
                            : "성장 통계 재집계"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && issues.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="py-10 text-center text-muted-foreground"
                    >
                      정합성 문제가 발견되지 않았습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && issues.length === 0 && (
                  <TableSkeletonRows columns={10} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-xs text-muted-foreground">
            {loading ? (
              <LoadingState active variant="inline" />
            ) : (
              `${issues.length.toLocaleString()}건 표시${
                data?.truncated ? ` (전체 ${summary?.total_issues?.toLocaleString()}건)` : ""
              }`
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
