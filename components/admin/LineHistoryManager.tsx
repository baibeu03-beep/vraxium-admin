"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, History } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatClubDate } from "@/lib/clubDate";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import {
  CLUSTER4_HUB_LABEL,
  type Cluster4LinePartType,
  type Cluster4OpenedLineDto,
} from "@/lib/adminCluster4LinesTypes";

// ──────────────────────────────────────────────────────────────
// 라인 개설 이력 — 과거/현재/전체 개설 라인을 표로 조회.
// GET /api/admin/cluster4/lines/history (단순 DB 조회, 스냅샷 무관).
// ──────────────────────────────────────────────────────────────

type StatusFilter = "all" | "current" | "past";

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "current", label: "현재" },
  { value: "past", label: "과거" },
];

const HUB_OPTIONS: { value: "" | Cluster4LinePartType; label: string }[] = [
  { value: "", label: "전체 허브" },
  { value: "info", label: CLUSTER4_HUB_LABEL.info },
  { value: "experience", label: CLUSTER4_HUB_LABEL.experience },
  { value: "competency", label: CLUSTER4_HUB_LABEL.competency },
  { value: "career", label: CLUSTER4_HUB_LABEL.career },
];

const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function StatusBadge({ status }: { status: Cluster4OpenedLineDto["status"] }) {
  const isPast = status === "past";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        isPast
          ? "bg-muted text-muted-foreground"
          : "bg-green-50 text-green-700 border border-green-200",
      )}
    >
      {isPast ? "과거(마감)" : "현재(진행)"}
    </span>
  );
}

export default function LineHistoryManager() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [partType, setPartType] = useState<"" | Cluster4LinePartType>("");
  const [seasonKey, setSeasonKey] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);

  const [rows, setRows] = useState<Cluster4OpenedLineDto[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // 시즌 드롭다운 옵션 — 마운트 시 1회(status=all, 넉넉한 limit) 로드해 고정한다.
  const [seasonOptions, setSeasonOptions] = useState<
    { key: string; name: string }[]
  >([]);
  const seasonLoadedRef = useRef(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("status", status);
      if (partType) qs.set("partType", partType);
      if (seasonKey) qs.set("seasonKey", seasonKey);
      if (query) qs.set("q", query);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));

      const res = await fetch(`/api/admin/cluster4/lines/history?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) {
        setRows([]);
        setTotal(0);
        setError(json.error ?? "개설 이력을 불러오지 못했습니다");
        return;
      }
      setRows(json.data.rows ?? []);
      setTotal(json.data.total ?? 0);
    } catch (e) {
      setRows([]);
      setTotal(0);
      setError(e instanceof Error ? e.message : "개설 이력을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [status, partType, seasonKey, query, offset]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // 시즌 옵션 1회 로드.
  useEffect(() => {
    if (seasonLoadedRef.current) return;
    seasonLoadedRef.current = true;
    (async () => {
      try {
        const res = await fetch(
          "/api/admin/cluster4/lines/history?status=all&limit=200",
        );
        const json = await res.json();
        if (!json.success) return;
        const seen = new Map<string, string>();
        for (const row of (json.data.rows ?? []) as Cluster4OpenedLineDto[]) {
          if (row.seasonKey && !seen.has(row.seasonKey)) {
            seen.set(row.seasonKey, row.seasonName ?? row.seasonKey);
          }
        }
        setSeasonOptions(
          Array.from(seen.entries())
            .map(([key, name]) => ({ key, name }))
            .sort((a, b) => (a.key < b.key ? 1 : -1)),
        );
      } catch {
        // 옵션 로드 실패는 치명적이지 않다 — 시즌 필터만 비워둔다.
      }
    })();
  }, []);

  // 필터 변경 시 첫 페이지로.
  const resetAndSet = useCallback(<T,>(setter: (v: T) => void, value: T) => {
    setter(value);
    setOffset(0);
  }, []);

  const submitSearch = useCallback(() => {
    setQuery(searchInput.trim());
    setOffset(0);
  }, [searchInput]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const hasFilters = useMemo(
    () => status !== "all" || partType !== "" || seasonKey !== "" || query !== "",
    [status, partType, seasonKey, query],
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-muted-foreground" />
            라인 개설 이력
          </CardTitle>
          <CardDescription>
            과거·현재·전체 개설 라인을 조회합니다. 기입 마감일 기준으로 현재(진행)/과거(마감)를
            구분하며, 단순 조회이므로 스냅샷/집계에 영향을 주지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 필터 바 */}
          <div className="flex flex-wrap items-center gap-3">
            {/* 상태 토글 */}
            <div className="inline-flex rounded-md border border-input p-0.5">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => resetAndSet(setStatus, tab.value)}
                  className={cn(
                    "rounded px-3 py-1 text-sm transition-colors",
                    status === tab.value
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 허브 필터 */}
            <select
              value={partType}
              onChange={(e) =>
                resetAndSet(
                  setPartType,
                  e.target.value as "" | Cluster4LinePartType,
                )
              }
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {HUB_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* 시즌 필터 */}
            <select
              value={seasonKey}
              onChange={(e) => resetAndSet(setSeasonKey, e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">전체 시즌</option>
              {seasonOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.name}
                </option>
              ))}
            </select>

            {/* 검색 */}
            <div className="flex items-center gap-2">
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                }}
                placeholder="라인명 검색"
                className="h-9 w-48"
              />
              <Button type="button" variant="secondary" onClick={submitSearch}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 에러 배너 */}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {/* 결과 카운트 */}
          <div className="text-sm text-muted-foreground">
            {loading ? (
              "불러오는 중…"
            ) : total === 0 ? (
              hasFilters ? "필터 결과가 없습니다." : "개설된 라인이 없습니다."
            ) : (
              <>
                전체 <span className="font-medium text-foreground">{total}</span>건 중{" "}
                {pageStart}–{pageEnd} 표시
              </>
            )}
          </div>

          {/* 표 */}
          {loading || rows.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>라인명</TableHead>
                    <TableHead>허브 / 카테고리</TableHead>
                    <TableHead>시즌 / 주차</TableHead>
                    <TableHead>시작일</TableHead>
                    <TableHead>종료일</TableHead>
                    <TableHead className="text-center">상태</TableHead>
                    <TableHead className="text-center">대상/제출</TableHead>
                    <TableHead>생성일</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 ? (
                    <TableSkeletonRows columns={8} rows={6} />
                  ) : (
                    rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="max-w-[18rem] truncate font-medium">
                        {row.lineName}
                        {!row.isActive && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (비활성)
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span>{row.hubName}</span>
                        {row.categoryName && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {row.categoryName}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {row.weekLabel ?? row.seasonName ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatClubDate(row.startDate)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatClubDate(row.endDate)}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-center text-sm tabular-nums">
                        {row.submissionCount} / {row.targetCount}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {formatDate(row.createdAt)}
                      </TableCell>
                    </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {hasFilters ? "필터 결과가 없습니다." : "개설된 라인이 없습니다."}
            </p>
          )}

          {/* 페이지네이션 */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canPrev || loading}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                이전
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canNext || loading}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                다음
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
