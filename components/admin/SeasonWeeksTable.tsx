"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, RotateCcw } from "lucide-react";
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
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatClubDate } from "@/lib/clubDate";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import {
  itemLabel,
  seasonOptions,
  YEAR_OPTIONS,
  SEASON_LABEL,
  type SeasonToken,
} from "@/lib/seasonSelectOptions";

// ── 데이터 타입: /api/admin/season-weeks 응답 DTO 그대로 (수정 금지) ──────────
type SeasonSummary = {
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
};

type OfficialRestSource = "season_rule" | "date_period" | "legacy_iso_week";

// 실무 경험 <확장> 류 라인 진행 방식. 서버 DTO(experienceExpansionLineMode)와 동일 union.
//   표 컬럼은 2026-07-16 제거됐으나(확장 SoT 를 주차 상세 저장값으로 일원화), DTO 호환을 위해
//   응답 필드 형상만 유지한다 — 렌더/정렬에는 사용하지 않는다.
type ExperienceExpansionLineMode = "none" | "online" | "offline";

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
  // 실무 경험 확장 류 라인 진행 방식. 구형 응답 호환 optional(누락 시 "none" 취급).
  experienceExpansionLineMode?: ExperienceExpansionLineMode;
};

type ApiPayload = {
  seasons?: SeasonSummary[];
  rows?: SeasonWeekRow[];
  // conflicts(공식 판정 vs legacy 불일치)는 진단 전용 필드로, 렌더에 사용하지 않는다.
  // API 는 계속 반환하지만(원장·정합성 로직 불변) UI 는 공식 판정값만 표시한다.
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

// 연도(기획 고정값 2022~2026)·계절 label 은 공용 SoT(@/lib/seasonSelectOptions) 재사용.
//   데이터 유무와 무관하게 노출. 보이드(-) 아래 최신 연도순.
// 시즌 필터 노출 순서: 봄·여름·가을·겨울. 라벨은 공용 SEASON_LABEL.
const SEASON_ORDER: SeasonToken[] = ["spring", "summer", "autumn", "winter"];
const SEASON_OPTIONS = SEASON_ORDER.map((key) => ({
  key,
  label: SEASON_LABEL[key],
}));

type ActivityKey = "official" | "rest";

const ACTIVITY_OPTIONS: { key: ActivityKey; label: string }[] = [
  { key: "official", label: "공식 활동" },
  { key: "rest", label: "공식 휴식" },
];

// base-ui Select 는 items 매핑이 있어야 닫힌 트리거에 라벨(값 아님)을 표시한다.
// 옵션 목록 렌더와 트리거 라벨 해석이 동일 배열(items SoT)을 쓰도록 한다.
const SORT_ITEMS = SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }));
const YEAR_ITEMS = [{ value: ALL, label: "-" }, ...YEAR_OPTIONS];
const SEASON_ITEMS = [
  { value: ALL, label: "-" },
  ...seasonOptions(SEASON_ORDER),
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
  return formatClubDate(value);
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
  return token ? SEASON_LABEL[token] : "-";
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
    return `${year.slice(2)}년 ${SEASON_LABEL[token]} 시즌 → ${nextYear.slice(2)}년 ${SEASON_LABEL[next]} 시즌으로의 시즌 전환 휴식`;
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
  helpKey,
  children,
}: {
  label: string;
  // 지정 시 라벨 오른쪽에 돋보기 도움말 아이콘. 드롭다운 폭/정렬은 건드리지 않는다.
  helpKey?: string;
  children: ReactNode;
}) {
  return (
    // shrink-0: 폭이 줄어도 라벨과 select 가 분리되지 않고 그룹 단위로 줄바꿈되도록.
    //   라벨↔select 간격(gap-1.5)은 기존 유지.
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {helpKey && (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        )}
      </span>
      {children}
    </div>
  );
}

// ── 테이블 컬럼 정렬/도움말 정의 ──────────────────────────────────────────────
//   · 모든 컬럼이 의미 있는 값을 가지므로 전부 정렬 가능(액션/체크박스/아이콘 전용 컬럼 없음).
//   · 정렬 기준값은 표시 문자열이 아니라 "실제 정렬 가능한 값"(날짜=ISO, 년도/주차=숫자,
//     시즌=시즌 순서 인덱스, 활동=구분 랭크). 문자열은 한글 포함 locale-aware.
type ColKey =
  | "name"
  | "period"
  | "year"
  | "season"
  | "week"
  | "activity"
  | "remark";
type SortValue = number | string | null;

const SEASON_SORT_ORDER: Record<SeasonToken, number> = {
  spring: 0,
  summer: 1,
  autumn: 2,
  winter: 3,
};

type ColumnDef = {
  key: ColKey;
  label: string;
  helpKey: string;
  sortValue: (row: SeasonWeekRow) => SortValue;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "name",
    label: "주차 코드",
    helpKey: "admin.seasonWeeks.column.name",
    // 주차 코드(문자열). 판별 불가("-")는 빈값 취급 → 항상 뒤로.
    sortValue: (row) => {
      const code = rowWeekCode(row);
      return code === "-" ? null : code;
    },
  },
  {
    key: "period",
    label: "기간",
    helpKey: "admin.seasonWeeks.column.period",
    // 표시 문자열이 아니라 실제 날짜(주차 시작일 ISO)로 정렬.
    sortValue: (row) => row.week_start_date ?? null,
  },
  {
    key: "year",
    label: "연도",
    helpKey: "admin.seasonWeeks.column.year",
    sortValue: (row) => {
      const y = rowYear(row);
      return y ? Number(y) : null;
    },
  },
  {
    key: "season",
    label: "시즌",
    helpKey: "admin.seasonWeeks.column.season",
    // 시즌 순서(봄→여름→가을→겨울). 전환 주차는 귀속 시즌 바로 뒤(+0.5).
    sortValue: (row) => {
      const token = rowSeasonToken(row);
      if (!token) return null;
      return SEASON_SORT_ORDER[token] + (row.is_transition ? 0.5 : 0);
    },
  },
  {
    key: "week",
    label: "주차",
    helpKey: "admin.seasonWeeks.column.week",
    sortValue: (row) => row.week_number ?? null,
  },
  {
    key: "activity",
    label: "활동",
    helpKey: "admin.seasonWeeks.column.activity",
    // 활동 구분 랭크: 공식 활동(0) → 공식 휴식(1) → 전환 주차(2).
    sortValue: (row) => (row.is_transition ? 2 : row.is_official_rest ? 1 : 0),
  },
  {
    key: "remark",
    label: "비고",
    helpKey: "admin.seasonWeeks.column.remark",
    sortValue: (row) => rowRemark(row) || null,
  },
  // [제거됨 2026-07-16] `[실무 경험] > 확장 류 라인` 컬럼은 더 이상 사용하지 않는다.
  //   이 컬럼은 cluster4_experience_extension_periods(확장 기간 원장)를 표시했으나, 확장 여부의
  //   단일 SoT 를 /admin/team-parts/info/weeks/[주차 상세] 의 관리자 저장값으로 일원화하면서
  //   혼동을 피하기 위해 표에서 내렸다. 서버 DTO(experienceExpansionLineMode)는 API 호환을 위해
  //   유지되지만 여기서 렌더하지 않는다(주차 상세의 확장 판정과는 무관·독립).
];

// null/빈값/"-" 은 정렬 방향과 무관하게 항상 뒤로. 숫자는 숫자, 문자열은 한글 locale.
function compareSortValues(
  a: SortValue,
  b: SortValue,
  dir: "asc" | "desc",
): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  let c: number;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else c = String(a).localeCompare(String(b), "ko");
  return dir === "asc" ? c : -c;
}

// 컬럼 헤더: 컬럼명+정렬 아이콘(button) 과 도움말(button) 을 형제로 둔다(버튼 중첩 방지).
//   · 도움말 버튼은 stopPropagation(AdminHelpIconButton 내부) + 구조 분리로 정렬을 트리거하지 않는다.
function SortableHeader({
  label,
  helpKey,
  dir,
  onSort,
}: {
  label: string;
  helpKey: string;
  dir: "asc" | "desc" | null;
  onSort: () => void;
}) {
  return (
    <TableHead
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <div className="inline-flex items-center justify-center gap-1">
        <button
          type="button"
          onClick={onSort}
          aria-label={`${label} 정렬`}
          className={cn(
            "inline-flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground hover:text-foreground",
            dir && "text-foreground",
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
        <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
      </div>
    </TableHead>
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
  // 사이드바 메뉴명과 페이지 제목 정합: 통합 모드 = "기간 정보", 조직 모드(?org) = "주차와 시즌".
  const org = readOrgParam(useSearchParams());
  const [rows, setRows] = useState<SeasonWeekRow[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading); // 전역 로딩 배너 보고
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 필터/정렬 상태
  const [sort, setSort] = useState<SortKey>("latest");
  const [yearFilter, setYearFilter] = useState<string>(ALL);
  const [seasonFilter, setSeasonFilter] = useState<string>(ALL);
  const [activityFilter, setActivityFilter] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  // 컬럼 헤더 클릭 정렬. null = 기본 순서(상단 정렬 드롭다운 기준).
  //   클릭 순환: 없음 → 오름차순 → 내림차순 → 기본 복귀.
  const [columnSort, setColumnSort] = useState<{
    key: ColKey;
    dir: "asc" | "desc";
  } | null>(null);

  const cycleSort = (key: ColKey) => {
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 내림차순 다음 클릭 → 기본 순서 복귀
    });
  };

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
          setGeneratedAt(data.generatedAt ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setRows([]);
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

  // 필터/정렬 변경 시 1페이지로 복귀.
  useEffect(() => {
    setPage(1);
  }, [sort, yearFilter, seasonFilter, activityFilter, columnSort]);

  // 필터만 적용(정렬 분리). rows.filter 는 새 배열 → 원본 mutate 없음.
  const filtered = useMemo(() => {
    return rows.filter((row) => {
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
  }, [rows, yearFilter, seasonFilter, activityFilter]);

  // 정렬: 컬럼 정렬이 활성이면 그 기준, 아니면 상단 드롭다운(최신/오래된) 기본 순서.
  //   원본(filtered) 을 mutate 하지 않도록 복사본을 정렬한다.
  const sorted = useMemo(() => {
    const list = [...filtered];
    if (columnSort) {
      const col = COLUMNS.find((c) => c.key === columnSort.key);
      if (col) {
        list.sort((a, b) => {
          const c = compareSortValues(
            col.sortValue(a),
            col.sortValue(b),
            columnSort.dir,
          );
          if (c !== 0) return c;
          // 동값 타이브레이크 — 주차 시작일 오름차순(안정적 표시).
          return (a.week_start_date ?? "").localeCompare(b.week_start_date ?? "");
        });
        return list;
      }
    }
    // 기본 순서: 주차 시작일(월요일) 기준. 최신 순=미래가 맨 위(desc). null 은 항상 뒤.
    list.sort((a, b) => {
      const as = a.week_start_date;
      const bs = b.week_start_date;
      if (as === bs) return (a.week_number ?? 0) - (b.week_number ?? 0);
      if (!as) return 1;
      if (!bs) return -1;
      return sort === "latest" ? bs.localeCompare(as) : as.localeCompare(bs);
    });
    return list;
  }, [filtered, columnSort, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sorted, safePage],
  );

  const resetFilters = () => {
    setSort("latest");
    setYearFilter(ALL);
    setSeasonFilter(ALL);
    setActivityFilter(ALL);
    setColumnSort(null);
    setPage(1);
  };

  return (
    {/* 섹션 간 세로 리듬 = 공용 SoT(admin-section-stack). flex flex-col gap-4(16px) 직접값
        대신 단일 출처로 이관 → 전역 2배 확대에 자동 정합(display 는 동일 flex-column). */}
    <div className="admin-section-stack">
      {/* 상단: 페이지 제목 */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-normal text-foreground">
          {org ? "주차와 시즌" : "기간 정보"}
        </h1>
        <AdminHelp />
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefreshTick((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            새로고침
          </Button>
          <AdminHelpIconButton
            helpKey="admin.seasonWeeks.button.refresh"
            title="새로고침"
            size="sm"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}


      {/* 필터/정렬 영역
          · 좌측 필터 4그룹은 flex-1 컨테이너 안에서 justify-between 으로 남는 가로 공간을
            고르게 활용(좌측 쏠림 방지). 우측 결과/초기화는 shrink-0 로 우측 정렬 유지.
          · 폭이 줄면 그룹 단위(FilterField=shrink-0)로 줄바꿈, 우측 영역도 다음 행으로.
            가로 스크롤은 생기지 않는다(min-w-0 + flex-wrap). */}
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-8 gap-y-3">
            <FilterField label="정렬" helpKey="admin.seasonWeeks.filter.sort">
              <Select
                items={SORT_ITEMS}
                value={sort}
                onValueChange={(v) => setSort((v as SortKey) ?? "latest")}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {(v) => itemLabel(SORT_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SORT_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="연도" helpKey="admin.seasonWeeks.filter.year">
              <Select
                items={YEAR_ITEMS}
                value={yearFilter}
                onValueChange={(v) => setYearFilter(v ?? ALL)}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {(v) => itemLabel(YEAR_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {YEAR_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="시즌" helpKey="admin.seasonWeeks.filter.season">
              <Select
                items={SEASON_ITEMS}
                value={seasonFilter}
                onValueChange={(v) => setSeasonFilter(v ?? ALL)}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {(v) => itemLabel(SEASON_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SEASON_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="활동" helpKey="admin.seasonWeeks.filter.activity">
              <Select
                items={ACTIVITY_ITEMS}
                value={activityFilter}
                onValueChange={(v) => setActivityFilter(v ?? ALL)}
              >
                <SelectTrigger size="sm">
                  <SelectValue>
                    {(v) => itemLabel(ACTIVITY_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className="text-sm text-muted-foreground tabular-nums"
              data-testid="result-count"
            >
              결과 수 {loading ? "-" : filtered.length}건
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
            <AdminHelpIconButton
              helpKey="admin.seasonWeeks.button.reset"
              title="초기화"
              size="xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* 테이블 — 최초 로딩(데이터 없음)에는 스켈레톤, 재요청(데이터 있음)에는
          기존 표를 유지하고 상단에 미니 진행 표시(요구사항 3). */}
      {loading && rows.length === 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col) => (
                  <SortableHeader
                    key={col.key}
                    label={col.label}
                    helpKey={col.helpKey}
                    dir={columnSort?.key === col.key ? columnSort.dir : null}
                    onSort={() => cycleSort(col.key)}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={COLUMNS.length} rows={8} />
            </TableBody>
          </Table>
        </div>
      ) : !loading && filtered.length === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          조건에 맞는 주차 데이터가 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          {/* 재요청 중 — 기존 데이터 유지 + 상단 미니 진행 표시. */}
          {loading && (
            <div className="border-b bg-muted/30 px-3 py-1.5">
              <LoadingState active variant="inline" />
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col) => (
                  <SortableHeader
                    key={col.key}
                    label={col.label}
                    helpKey={col.helpKey}
                    dir={columnSort?.key === col.key ? columnSort.dir : null}
                    onSort={() => cycleSort(col.key)}
                  />
                ))}
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
        <p className="text-xs text-muted-foreground">
          조회 시각 {formatAdminDateTime(generatedAt)}
        </p>
      )}
    </div>
  );
}
