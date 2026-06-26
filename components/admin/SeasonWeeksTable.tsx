"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";

// ── 데이터 타입: /api/admin/season-weeks 응답 DTO 그대로 (수정 금지) ──────────
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
  // 전환 주차: 시즌 사이 gap 주차. 직전 시즌에 귀속. 구형 캐시 응답 호환 optional.
  is_transition?: boolean;
  // 사용자 노출용 비고(휴식명/설명) — weeks.holiday_name. 구형 응답 호환 optional.
  holiday_name?: string | null;
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

type ApiPayload = {
  seasons?: SeasonSummary[];
  rows?: SeasonWeekRow[];
  conflicts?: SeasonWeekConflict[];
  generatedAt?: string;
};

// ── 필터/정렬 상수 ───────────────────────────────────────────────────────────
const ALL = "__all__";
const PAGE_SIZE = 20;

type SortKey = "latest" | "oldest";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "latest", label: "최신 순" },
  { key: "oldest", label: "오래된 순" },
];

// 년도 옵션은 기획 고정값 (데이터 유무와 무관하게 노출). 보이드(-) 아래 최신 년도순.
const YEAR_OPTIONS = ["2026", "2025", "2024", "2023", "2022"] as const;

type SeasonToken = "spring" | "summer" | "autumn" | "winter";

const SEASON_OPTIONS: { key: SeasonToken; label: string }[] = [
  { key: "spring", label: "봄" },
  { key: "summer", label: "여름" },
  { key: "autumn", label: "가을" },
  { key: "winter", label: "겨울" },
];

const SEASON_TOKEN_LABEL: Record<SeasonToken, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};

type ActivityKey = "official" | "rest";

const ACTIVITY_OPTIONS: { key: ActivityKey; label: string }[] = [
  { key: "official", label: "공식 활동" },
  { key: "rest", label: "공식 휴식" },
];

// base-ui Select 는 items 매핑이 있어야 닫힌 트리거에 라벨(값 아님)을 표시한다.
const SORT_ITEMS = SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }));
const YEAR_ITEMS = [
  { value: ALL, label: "-" },
  ...YEAR_OPTIONS.map((y) => ({ value: y, label: `${y}년` })),
];
const SEASON_ITEMS = [
  { value: ALL, label: "-" },
  ...SEASON_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
];
const ACTIVITY_ITEMS = [
  { value: ALL, label: "-" },
  ...ACTIVITY_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
];

// 주차 코드 표시(UI 계산 전용 — DB 저장 없음, weeks.id UUID 비노출).
// 하이픈 통일 형식 — 일반: {YY}-{SP|SU|AU|WI}-{NN} / 전환: {YY}-{현재 시즌}-{다음 시즌}
const SEASON_CODE: Record<SeasonToken, string> = {
  spring: "SP",
  summer: "SU",
  autumn: "AU",
  winter: "WI",
};

const NEXT_SEASON: Record<SeasonToken, SeasonToken> = {
  spring: "summer",
  summer: "autumn",
  autumn: "winter",
  winter: "spring",
};

// ── 표시 헬퍼 ────────────────────────────────────────────────────────────────
function formatKoreanDate(value: string | null | undefined) {
  if (!value) return null;
  const [y, m, d] = value.split("-");
  if (!y || !m || !d) return value;
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}

function formatPeriod(start: string | null, end: string | null) {
  const s = formatKoreanDate(start);
  const e = formatKoreanDate(end);
  if (s && e) return `${s} → ${e}`;
  return s ?? e ?? "-";
}

function rowYear(row: SeasonWeekRow): string | null {
  return row.week_start_date ? row.week_start_date.slice(0, 4) : null;
}

// 주차가 속한 시즌 종류: season_key 토큰 우선, 라벨/이름의 한글 시즌명 폴백.
function rowSeasonToken(row: SeasonWeekRow): SeasonToken | null {
  const key = row.season_key.toLowerCase();
  for (const option of SEASON_OPTIONS) {
    if (key.includes(option.key)) return option.key;
  }
  const name = `${row.season_label ?? ""}${row.season_name ?? ""}`;
  if (name.includes("봄")) return "spring";
  if (name.includes("여름")) return "summer";
  if (name.includes("가을")) return "autumn";
  if (name.includes("겨울")) return "winter";
  return null;
}

// 시즌 컬럼 표기: 전환 주차는 "전환", 그 외는 봄/여름/가을/겨울.
function rowSeasonLabel(row: SeasonWeekRow): string {
  if (row.is_transition) return "전환";
  const token = rowSeasonToken(row);
  return token ? SEASON_TOKEN_LABEL[token] : "-";
}

// 주차 코드의 년도: 시즌 귀속 년도(season_key 의 4자리) 우선, 주차 시작일 폴백.
function rowSeasonYear(row: SeasonWeekRow): string | null {
  const m = row.season_key.match(/(20\d{2})/);
  if (m) return m[1];
  return rowYear(row);
}

function rowWeekCode(row: SeasonWeekRow): string {
  const token = rowSeasonToken(row);
  const year = rowSeasonYear(row);
  if (!token || !year) return "-";
  const yy = year.slice(2);
  if (row.is_transition) {
    return `${yy}-${SEASON_CODE[token]}-${SEASON_CODE[NEXT_SEASON[token]]}`;
  }
  if (row.week_number == null) return "-";
  return `${yy}-${SEASON_CODE[token]}-${String(row.week_number).padStart(2, "0")}`;
}

// 비고: 사용자 노출용 설명. UI 파생 텍스트 전용(DB 저장/backfill 없음).
// 우선순위 — 1) weeks.holiday_name 2) 전환 주차 자동 문구
// 3) 공식 휴식 + 시험기간 규칙(봄/가을 6~8주=중간고사, 14~16주=기말고사) 파생 문구
// 판별 불가는 빈칸. 내부 판정 출처(official_rest_sources) 원문은 노출하지 않는다.
function rowRemark(row: SeasonWeekRow): string {
  const holidayName = row.holiday_name?.trim();
  if (holidayName) return holidayName;

  const token = rowSeasonToken(row);
  const year = rowSeasonYear(row);

  if (row.is_transition) {
    if (!token || !year) return "";
    const next = NEXT_SEASON[token];
    // 겨울 → 봄 전환은 해가 바뀐다.
    const nextYear = token === "winter" ? String(Number(year) + 1) : year;
    return `${year.slice(2)}년 ${SEASON_TOKEN_LABEL[token]} 시즌 → ${nextYear.slice(2)}년 ${SEASON_TOKEN_LABEL[next]} 시즌으로의 시즌 전환 휴식`;
  }

  if (!row.is_official_rest) return "";

  // 시험기간 규칙 파생: 봄=1학기, 가을=2학기 (여름/겨울 시즌엔 시험기간 휴식 없음)
  if (
    (token === "spring" || token === "autumn") &&
    row.week_number != null
  ) {
    const semester = token === "spring" ? "1학기" : "2학기";
    if (row.week_number >= 6 && row.week_number <= 8) {
      return `대한민국 2/4년제 대학 학사 일정 중 ${semester} 중간고사 휴식`;
    }
    if (row.week_number >= 14 && row.week_number <= 16) {
      return `대한민국 2/4년제 대학 학사 일정 중 ${semester} 기말고사 휴식`;
    }
  }

  // 명절(날짜 등록) 휴식인데 holiday_name 이 없으면 명절명 판별 불가 → 빈칸.
  return "";
}

function ActivityBadge({
  isRest,
  isTransition,
}: {
  isRest: boolean;
  isTransition?: boolean;
}) {
  // 전환 주차는 공식 휴식이 아니므로(is_official_rest=false) 별도 배지로 표기한다.
  if (isTransition) {
    return (
      <span className="inline-flex h-6 items-center rounded-md bg-sky-100 px-2 text-xs font-medium text-sky-800 ring-1 ring-sky-200">
        전환 주차
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
        isRest
          ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
          : "bg-muted text-muted-foreground",
      )}
    >
      {isRest ? "공식 휴식" : "공식 활동"}
    </span>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// 페이지 번호 목록(현재 페이지 주변 windowing, 최대 5개).
function pageNumbers(current: number, total: number): number[] {
  const window = 5;
  let start = Math.max(1, current - Math.floor(window / 2));
  const end = Math.min(total, start + window - 1);
  start = Math.max(1, end - window + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  return pages;
}

export default function SeasonWeeksTable() {
  const [rows, setRows] = useState<SeasonWeekRow[]>([]);
  const [conflicts, setConflicts] = useState<SeasonWeekConflict[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 필터/정렬 상태
  const [sort, setSort] = useState<SortKey>("latest");
  const [yearFilter, setYearFilter] = useState<string>(ALL);
  const [seasonFilter, setSeasonFilter] = useState<string>(ALL);
  const [activityFilter, setActivityFilter] = useState<string>(ALL);
  const [page, setPage] = useState(1);

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
        if (!cancelled) {
          setRows(data.rows ?? []);
          setConflicts(data.conflicts ?? []);
          setGeneratedAt(data.generatedAt ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
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

  // 필터 변경 시 1페이지로 복귀.
  useEffect(() => {
    setPage(1);
  }, [sort, yearFilter, seasonFilter, activityFilter]);

  const filtered = useMemo(() => {
    const list = rows.filter((row) => {
      if (yearFilter !== ALL && rowYear(row) !== yearFilter) return false;
      if (seasonFilter !== ALL && rowSeasonToken(row) !== seasonFilter)
        return false;
      if (activityFilter !== ALL) {
        const isRest = row.is_official_rest;
        if (activityFilter === "rest" && !isRest) return false;
        if (activityFilter === "official" && isRest) return false;
      }
      return true;
    });

    // 정렬: 주차 시작일(월요일) 기준. 최신 순=미래가 맨 위(desc). null 은 항상 뒤.
    return list.sort((a, b) => {
      const as = a.week_start_date;
      const bs = b.week_start_date;
      if (as === bs) return (a.week_number ?? 0) - (b.week_number ?? 0);
      if (!as) return 1;
      if (!bs) return -1;
      return sort === "latest" ? bs.localeCompare(as) : as.localeCompare(bs);
    });
  }, [rows, sort, yearFilter, seasonFilter, activityFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const resetFilters = () => {
    setSort("latest");
    setYearFilter(ALL);
    setSeasonFilter(ALL);
    setActivityFilter(ALL);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 상단: 페이지 제목 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-foreground">
            기간 정보
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            기간 등록에서 등록된 주차 정보를 조회합니다.
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

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 규칙 충돌 안내(정합 점검용) — 데이터 자체는 그대로 노출 */}
      {!loading && conflicts.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          공식 휴식 판정과 legacy 값이 어긋나는 주차 {conflicts.length}건이
          감지되었습니다.
        </div>
      )}

      {/* 필터/정렬 영역 */}
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <FilterField label="정렬">
            <Select
              items={SORT_ITEMS}
              value={sort}
              onValueChange={(v) => setSort((v as SortKey) ?? "latest")}
            >
              <SelectTrigger className="w-28" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="년도">
            <Select
              items={YEAR_ITEMS}
              value={yearFilter}
              onValueChange={(v) => setYearFilter(v ?? ALL)}
            >
              <SelectTrigger className="w-28" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>-</SelectItem>
                {YEAR_OPTIONS.map((year) => (
                  <SelectItem key={year} value={year}>
                    {year}년
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="시즌">
            <Select
              items={SEASON_ITEMS}
              value={seasonFilter}
              onValueChange={(v) => setSeasonFilter(v ?? ALL)}
            >
              <SelectTrigger className="w-24" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>-</SelectItem>
                {SEASON_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label="활동">
            <Select
              items={ACTIVITY_ITEMS}
              value={activityFilter}
              onValueChange={(v) => setActivityFilter(v ?? ALL)}
            >
              <SelectTrigger className="w-28" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>-</SelectItem>
                {ACTIVITY_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <div className="ml-auto flex items-center gap-2">
            <span
              className="text-sm text-muted-foreground tabular-nums"
              data-testid="result-count"
            >
              결과 {loading ? "-" : filtered.length}건
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetFilters}
              disabled={loading}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 테이블 */}
      {loading ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>기간</TableHead>
                <TableHead>년도</TableHead>
                <TableHead>시즌</TableHead>
                <TableHead>주차</TableHead>
                <TableHead>활동</TableHead>
                <TableHead>비고</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={7} rows={8} />
            </TableBody>
          </Table>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          조건에 맞는 주차 데이터가 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>기간</TableHead>
                <TableHead>년도</TableHead>
                <TableHead>시즌</TableHead>
                <TableHead>주차</TableHead>
                <TableHead>활동</TableHead>
                <TableHead>비고</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => {
                const year = rowYear(row);
                return (
                  <TableRow
                    key={row.week_id}
                    className={cn(row.is_current_week && "bg-primary/5")}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      {rowWeekCode(row)}
                    </TableCell>
                    <TableCell>
                      {formatPeriod(row.week_start_date, row.week_end_date)}
                    </TableCell>
                    <TableCell>{year ? `${year}년` : "-"}</TableCell>
                    <TableCell>{rowSeasonLabel(row)}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.week_number ?? "-"}
                    </TableCell>
                    <TableCell>
                      <ActivityBadge
                        isRest={row.is_official_rest}
                        isTransition={row.is_transition}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {rowRemark(row)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 하단: 페이지네이션 */}
      {!loading && filtered.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            이전
          </Button>
          {pageNumbers(safePage, totalPages).map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={p === safePage ? "default" : "outline"}
              onClick={() => setPage(p)}
              className="tabular-nums"
            >
              {p}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            다음
          </Button>
          <span className="ml-2 text-xs text-muted-foreground tabular-nums">
            {safePage} / {totalPages} 페이지
          </span>
        </div>
      )}

      {generatedAt && (
        <p className="text-xs text-muted-foreground">조회 시각 {generatedAt}</p>
      )}
    </div>
  );
}
