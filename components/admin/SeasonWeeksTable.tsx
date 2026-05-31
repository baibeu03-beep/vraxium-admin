"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";

type SeasonSummary = {
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
};

type OfficialRestSource = "season_rule" | "date_period" | "legacy_iso_week";

type SeasonWeekRow = SeasonSummary & {
  week_id: string;
  week_number: number | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  is_official_rest: boolean;
  official_rest_sources?: OfficialRestSource[];
  is_current_week: boolean;
};

type SeasonWeekConflict = {
  season_key: string;
  week_id: string;
  week_number: number | null;
  week_start_date: string | null;
  resolved_is_official_rest: boolean;
  legacy_is_official_rest: boolean;
  reason: string;
};

const SOURCE_LABELS: Record<OfficialRestSource, string> = {
  season_rule: "시험기간 규칙",
  date_period: "날짜 등록",
  legacy_iso_week: "legacy",
};

type ApiPayload = {
  seasons?: SeasonSummary[];
  rows?: SeasonWeekRow[];
  conflicts?: SeasonWeekConflict[];
  generatedAt?: string;
};

type SeasonGroup = SeasonSummary & {
  rows: SeasonWeekRow[];
  officialRestCount: number;
  isCurrentSeason: boolean;
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

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

function isTodayInRange(start: string | null, end: string | null, today: string) {
  if (!start || !end) return false;
  return start <= today && today <= end;
}

function StatusBadge({
  tone,
  children,
}: {
  tone: "current" | "rest" | "warning" | "muted";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
        tone === "current" && "bg-primary text-primary-foreground",
        tone === "rest" && "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
        tone === "warning" && "bg-red-100 text-red-800 ring-1 ring-red-200",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export default function SeasonWeeksTable() {
  const [seasons, setSeasons] = useState<SeasonSummary[]>([]);
  const [rows, setRows] = useState<SeasonWeekRow[]>([]);
  const [conflicts, setConflicts] = useState<SeasonWeekConflict[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/admin/season-weeks", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load season weeks.");
        }

        const data = (json.data ?? {}) as ApiPayload;
        const nextRows = data.rows ?? [];
        const nextSeasons =
          data.seasons ??
          Array.from(
            new Map(
              nextRows.map((row) => [
                row.season_key,
                {
                  season_key: row.season_key,
                  season_label: row.season_label,
                  season_name: row.season_name,
                  season_start_date: row.season_start_date,
                  season_end_date: row.season_end_date,
                } satisfies SeasonSummary,
              ]),
            ).values(),
          );

        if (!cancelled) {
          setSeasons(nextSeasons);
          setRows(nextRows);
          setConflicts(data.conflicts ?? []);
          setGeneratedAt(data.generatedAt ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setSeasons([]);
          setRows([]);
          setConflicts([]);
          setGeneratedAt(null);
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

  const conflictByWeekId = useMemo(() => {
    return new Map(conflicts.map((conflict) => [conflict.week_id, conflict]));
  }, [conflicts]);

  const groups = useMemo<SeasonGroup[]>(() => {
    const rowsBySeason = new Map<string, SeasonWeekRow[]>();
    for (const row of rows) {
      const list = rowsBySeason.get(row.season_key) ?? [];
      list.push(row);
      rowsBySeason.set(row.season_key, list);
    }

    const today = new Date().toISOString().slice(0, 10);
    return seasons.map((season) => {
      const seasonRows = rowsBySeason.get(season.season_key) ?? [];
      return {
        ...season,
        rows: seasonRows,
        officialRestCount: seasonRows.filter((row) => row.is_official_rest)
          .length,
        isCurrentSeason:
          seasonRows.some((row) => row.is_current_week) ||
          isTodayInRange(
            season.season_start_date,
            season.season_end_date,
            today,
          ),
      };
    });
  }, [rows, seasons]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-foreground">
            시즌/주차 기준표
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            운영 기준이 되는 시즌과 주차 데이터를 조회합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setRefreshTick((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>시즌</CardDescription>
            <CardTitle>{loading ? "-" : `${groups.length}개`}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>주차</CardDescription>
            <CardTitle>{loading ? "-" : `${rows.length}개`}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>규칙 충돌</CardDescription>
            <CardTitle>{loading ? "-" : `${conflicts.length}건`}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          데이터를 불러오는 중입니다.
        </div>
      ) : groups.length === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          표시할 시즌/주차 데이터가 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <Card key={group.season_key}>
              <CardHeader className="border-b">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>
                        {group.season_label ?? group.season_name ?? "-"}
                      </CardTitle>
                      <span className="font-mono text-xs text-muted-foreground">
                        {group.season_key}
                      </span>
                      {group.isCurrentSeason && (
                        <StatusBadge tone="current">현재 시즌</StatusBadge>
                      )}
                    </div>
                    <CardDescription className="mt-1">
                      {formatRange(
                        group.season_start_date,
                        group.season_end_date,
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md bg-muted px-2 py-1">
                      총 {group.rows.length}주차
                    </span>
                    <span className="rounded-md bg-muted px-2 py-1">
                      공식 휴식 {group.officialRestCount}주차
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                {group.rows.length === 0 ? (
                  <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                    이 시즌에 연결된 주차 데이터가 없습니다.
                  </div>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>주차</TableHead>
                          <TableHead>주차 기간</TableHead>
                          <TableHead>공식 휴식 여부</TableHead>
                          <TableHead>판정 출처</TableHead>
                          <TableHead>현재 주차 여부</TableHead>
                          <TableHead>규칙 충돌</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.rows.map((row) => {
                          const conflict = conflictByWeekId.get(row.week_id);
                          return (
                            <TableRow
                              key={row.week_id}
                              className={cn(
                                row.is_current_week && "bg-primary/5",
                                conflict && "bg-red-50/60",
                              )}
                            >
                              <TableCell className="font-medium">
                                {row.week_label}
                              </TableCell>
                              <TableCell>
                                {formatRange(
                                  row.week_start_date,
                                  row.week_end_date,
                                )}
                              </TableCell>
                              <TableCell>
                                {row.is_official_rest ? (
                                  <StatusBadge tone="rest">
                                    공식 휴식
                                  </StatusBadge>
                                ) : (
                                  <StatusBadge tone="muted">운영</StatusBadge>
                                )}
                              </TableCell>
                              <TableCell>
                                {row.official_rest_sources &&
                                row.official_rest_sources.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {row.official_rest_sources.map((source) => (
                                      <span
                                        key={source}
                                        className={cn(
                                          "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
                                          source === "legacy_iso_week"
                                            ? "bg-muted text-muted-foreground line-through"
                                            : "bg-sky-100 text-sky-800 ring-1 ring-sky-200",
                                        )}
                                      >
                                        {SOURCE_LABELS[source]}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {row.is_current_week ? (
                                  <StatusBadge tone="current">
                                    현재 주차
                                  </StatusBadge>
                                ) : (
                                  <span className="text-muted-foreground">
                                    -
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {conflict ? (
                                  <StatusBadge tone="warning">
                                    판정{" "}
                                    {conflict.resolved_is_official_rest
                                      ? "휴식"
                                      : "운영"}{" "}
                                    / legacy{" "}
                                    {conflict.legacy_is_official_rest
                                      ? "휴식"
                                      : "운영"}
                                  </StatusBadge>
                                ) : (
                                  <span className="text-muted-foreground">
                                    -
                                  </span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {generatedAt && (
        <p className="text-xs text-muted-foreground">조회 시각 {generatedAt}</p>
      )}
    </div>
  );
}
