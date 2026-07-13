"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClubDateTime } from "@/lib/clubDate";
import { LoadingState } from "@/components/ui/loading-state";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import {
  formatBannerPeriod,
  formatFullDateRangeKo,
} from "@/lib/practicalInfoSection0Format";
import PracticalInfoCurrentSituation from "@/components/admin/PracticalInfoCurrentSituation";
import { useLineManageWeekOptions } from "@/lib/lineManageWeekOptions";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";

// 실무 역량 [라인 관리] 탭 — 상단 보드.
//   "[실무 역량] Hub" 제목 + 현재 상황(오늘/개설 필요/개설 이행 기간, practical-info 공용) +
//   주차 드롭다운(좌) + 6 집계 카드(우). 집계는 라인 개설 탭과 동일 DTO(competency/applications)
//   를 주차만 바꿔(week_id) 조회 → 같은 주차면 값 일치. snapshot 무관(읽기 전용).

type Summary = {
  activeCrews: number;
  appliedCrews: number;
  openedCrews: number;
  rejectedCrews: number;
  appliedLines: number;
  openedLines: number;
};

const EMPTY: Summary = {
  activeCrews: 0,
  appliedCrews: 0,
  openedCrews: 0,
  rejectedCrews: 0,
  appliedLines: 0,
  openedLines: 0,
};

// 크루별 라인 개설 결과 행 (competency/applications DTO 의 results).
type CrewResult = {
  userId: string;
  crewNo: number | null;
  crewCode: string | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  progressLine: string | null;
  result: "success" | "fail";
  appliedAt: string | null;
  applied: boolean;
};

// 신청 시간 표기 — KST 기준 "26 - 07 - 06 (월) 21:52". 미신청('-').
function formatAppliedAt(iso: string | null): string {
  return formatClubDateTime(iso);
}

// ── 테이블 컬럼 정의(헤더 라벨 · 도움말 키 · 정렬 기준) — RestManagementManager 와 동일 패턴 ──
//   · 모든 org / mode=test 가 이 단일 배열을 공유(모드 분기 없음).
//   · 정렬 기준은 표시 문자열이 아니라 실제 값: 라인 결과=업무 순서(enum), 신청 시간=timestamp(ISO),
//     크루/팀/학교/진행 라인=한글 locale 문자열(빈값은 방향 무관 항상 뒤).
type ColKey =
  | "crewCode"
  | "crewName"
  | "team"
  | "school"
  | "progressLine"
  | "result"
  | "appliedAt";
type SortValue = number | string | null;

// 라인 결과 업무 순서: 강화 성공 → 강화 실패.
const RESULT_SORT_ORDER: Record<"success" | "fail", number> = {
  success: 0,
  fail: 1,
};

// 빈값 규칙: null/undefined/빈문자열/공백/"-" → null(항상 뒤).
function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" || t === "-" ? null : t;
}

type ColumnDef = {
  key: ColKey;
  label: string;
  helpKey: string;
  sortValue: (row: CrewResult) => SortValue;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "crewCode",
    label: "크루 코드",
    helpKey: ADMIN_SHARED_HELP_KEYS.crew.code,
    sortValue: (r) => emptyToNull(r.crewCode),
  },
  {
    key: "crewName",
    label: "크루명",
    helpKey: ADMIN_SHARED_HELP_KEYS.crew.name,
    sortValue: (r) => emptyToNull(r.displayName),
  },
  {
    key: "team",
    label: "소속 팀",
    helpKey: "admin.lineOpening.competency.manage.column.team",
    sortValue: (r) => emptyToNull(r.teamName),
  },
  {
    key: "school",
    label: "학교",
    helpKey: "admin.lineOpening.competency.manage.column.school",
    sortValue: (r) => emptyToNull(r.schoolName),
  },
  {
    key: "progressLine",
    label: "진행 라인",
    helpKey: "admin.lineOpening.competency.manage.column.progressLine",
    sortValue: (r) => emptyToNull(r.progressLine),
  },
  {
    key: "result",
    label: "라인 결과",
    helpKey: "admin.lineOpening.competency.manage.column.result",
    sortValue: (r) => RESULT_SORT_ORDER[r.result],
  },
  {
    key: "appliedAt",
    label: "신청 시간",
    helpKey: "admin.lineOpening.competency.manage.column.appliedAt",
    // 표시 문자열이 아니라 실제 timestamp(ISO)로 정렬.
    sortValue: (r) => r.appliedAt ?? null,
  },
];

// null/빈값/"-" 은 방향 무관 항상 뒤. 숫자는 숫자, 문자열은 한글 locale.
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

// 컬럼 헤더(plain <th>): 정렬 트리거(button)와 도움말(button)을 형제로 둔다(버튼 중첩 방지).
function ColumnHeader({
  col,
  dir,
  onSort,
}: {
  col: ColumnDef;
  dir: "asc" | "desc" | null;
  onSort: () => void;
}) {
  return (
    <th
      className="px-3 py-2 font-medium"
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={onSort}
          aria-label={`${col.label} 정렬`}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            dir && "text-foreground",
          )}
        >
          <span>{col.label}</span>
          {dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : dir === "desc" ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-40" />
          )}
        </button>
        <AdminHelpIconButton helpKey={col.helpKey} title={col.label} size="xs" />
      </div>
    </th>
  );
}

function StatCard({
  label,
  value,
  tone,
  helpKey,
}: {
  label: string;
  value: number;
  tone?: "default" | "info" | "success" | "error";
  helpKey?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-[78px] rounded-md border px-4 py-2 text-center",
        tone === "info" && "border-blue-200 bg-blue-50",
        tone === "success" && "border-green-200 bg-green-50",
        tone === "error" && "border-red-200 bg-red-50",
        (!tone || tone === "default") && "border-border bg-muted",
      )}
    >
      <p className="text-xl font-bold leading-none">{value}</p>
      <p className="mt-1 inline-flex items-center justify-center gap-1 text-xs text-muted-foreground">
        {label}
        {helpKey ? (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        ) : null}
      </p>
    </div>
  );
}

export default function CompetencyLineManageBoard({
  refreshKey,
}: {
  refreshKey?: number;
}) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 운영/테스트 모드 — 집계/결과 모집단을 현재 모드로 한정.
  const mode = readScopeMode(searchParams);

  // 주차 드롭다운 — 실무 정보 라인 관리와 동일 SoT(season-weeks 전 주차). 공용 hook 사용.
  //   "라인 관리"는 조회/관리용이므로 최근 N주로 제한하지 않는다(개설 정책은 별개·불변).
  const { options: weekOptions, defaultWeekId, ready: weeksReady } =
    useLineManageWeekOptions();
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [results, setResults] = useState<CrewResult[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 기본 선택 = openable(개설 대상) → 현재 → 최신(공용 hook 산출). 이미 선택된 값은 유지.
  useEffect(() => {
    if (defaultWeekId) setSelectedWeekId((prev) => prev || defaultWeekId);
  }, [defaultWeekId]);

  // 바깥 클릭 시 드롭다운 닫기.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // 선택 주차 기준 집계 조회 — 라인 개설 탭과 동일 endpoint/DTO(week_id 만 추가).
  useEffect(() => {
    if (!org || !weeksReady) return;
    // 주차 옵션이 있으면 기본 선택(defaultWeekId)이 적용될 때까지 대기 — selectedWeekId 가 아직 ""
    //   인 채로 먼저 조회하면 "week_id 없음"으로 한 번, 직후 defaultWeekId 로 또 한 번(중복 2회) 나간다.
    //   옵션이 아예 없을 때만 빈 주차로 1회 조회(서버가 개설 대상 주차로 fallback).
    if (!selectedWeekId && weekOptions.length > 0) return;
    let cancelled = false;
    void (async () => {
      if (!cancelled) setLoading(true);
      try {
        const qs = new URLSearchParams({ organization: org });
        if (selectedWeekId) qs.set("week_id", selectedWeekId);
        if (mode === "test") qs.set("mode", "test");
        const res = await fetch(
          `/api/admin/cluster4/competency/applications?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        setSummary(json?.success ? (json.data?.summary ?? EMPTY) : EMPTY);
        setResults(json?.success ? ((json.data?.results ?? []) as CrewResult[]) : []);
      } catch {
        if (!cancelled) {
          setSummary(EMPTY);
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, mode, selectedWeekId, weeksReady, weekOptions.length, refreshKey]);

  const selectedWeek = weekOptions.find((w) => w.id === selectedWeekId) ?? null;

  // 컬럼 헤더 클릭 정렬. null = 서버 기본 순서. 클릭 순환: 없음 → 오름차순 → 내림차순 → 기본.
  const [columnSort, setColumnSort] = useState<{
    key: ColKey;
    dir: "asc" | "desc";
  } | null>(null);
  const cycleSort = (key: ColKey) =>
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });

  // 원본(results)은 mutate 하지 않고 복사본을 정렬. columnSort=null 이면 원본 순서 그대로.
  const sortedResults = useMemo(() => {
    if (!columnSort) return results;
    const col = COLUMNS.find((c) => c.key === columnSort.key);
    if (!col) return results;
    const sv = col.sortValue;
    return [...results].sort((a, b) =>
      compareSortValues(sv(a), sv(b), columnSort.dir),
    );
  }, [results, columnSort]);

  return (
    <div className="space-y-4">
      <h1 className="inline-flex items-center gap-2 text-2xl font-bold">
        [실무 역량] Hub
        <AdminHelpIconButton
          helpKey="admin.lineOpening.competency.title.hub"
          title="[실무 역량] Hub"
          size="sm"
        />
      </h1>

      {/* 오늘 날짜 / 개설 필요 기간 / 개설 이행 기간 (practical-info 공용·동일 SoT) */}
      <PracticalInfoCurrentSituation />

      {/* 주차 선택(좌) + 6 집계 카드(우) — 한 행 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="주차 선택"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex min-w-[220px] items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-base font-semibold"
          >
            <span className={cn(!selectedWeek && "text-muted-foreground")}>
              {selectedWeek
                ? formatBannerPeriod({
                    year: selectedWeek.year,
                    seasonName: selectedWeek.seasonName,
                    weekNumber: selectedWeek.weekNumber,
                  })
                : "주차를 불러오는 중…"}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          {menuOpen && weekOptions.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-72 w-[280px] overflow-y-auto rounded-md border bg-background py-1 shadow-md">
              {weekOptions.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    setSelectedWeekId(w.id);
                    setMenuOpen(false);
                  }}
                  className={cn(
                    "block w-full px-3 py-1.5 text-left hover:bg-muted",
                    selectedWeekId === w.id && "bg-muted",
                  )}
                >
                  <div className="text-sm font-medium">
                    {formatBannerPeriod({
                      year: w.year,
                      seasonName: w.seasonName,
                      weekNumber: w.weekNumber,
                    })}
                    {w.isOpenTarget ? " · 개설대상" : ""}
                    {w.isCurrent ? " · 현재" : ""}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {w.startDate && w.endDate
                      ? formatFullDateRangeKo(w.startDate, w.endDate)
                      : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.filter.week"
            title="주차 선택"
            size="sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {loading ? (
            <LoadingState active variant="inline" />
          ) : (
            <>
              <StatCard
                label="활동 크루"
                value={summary.activeCrews}
                helpKey="admin.lineOpening.competency.stat.activeCrews"
              />
              <StatCard
                label="신청 크루"
                value={summary.appliedCrews}
                tone="info"
                helpKey="admin.lineOpening.competency.stat.appliedCrews"
              />
              <StatCard
                label="개설 크루"
                value={summary.openedCrews}
                tone="success"
                helpKey="admin.lineOpening.competency.stat.openedCrews"
              />
              <StatCard
                label="반려 크루"
                value={summary.rejectedCrews}
                tone="error"
                helpKey="admin.lineOpening.competency.stat.rejectedCrews"
              />
              <StatCard
                label="신청 라인"
                value={summary.appliedLines}
                tone="info"
                helpKey="admin.lineOpening.competency.stat.appliedLines"
              />
              <StatCard
                label="개설 라인"
                value={summary.openedLines}
                tone="success"
                helpKey="admin.lineOpening.competency.stat.openedLines"
              />
            </>
          )}
        </div>
      </div>

      {/* 선택 주차의 [실무 역량] 크루별 라인 개설 결과 표 (집계 카드와 동일 DTO 의 results) */}
      <div className="rounded-lg border">
        <div className="flex items-center gap-1 border-b bg-muted/30 px-4 py-2 text-sm font-semibold">
          <span>
            크루별 라인 개설 결과
            {selectedWeek
              ? ` — ${formatBannerPeriod({
                  year: selectedWeek.year,
                  seasonName: selectedWeek.seasonName,
                  weekNumber: selectedWeek.weekNumber,
                })}`
              : ""}
          </span>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.title.manageTable"
            title="크루별 라인 개설 결과"
            size="xs"
          />
        </div>
        {loading ? (
          <LoadingState active />
        ) : results.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            해당 주차의 활동 대상 크루가 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {COLUMNS.map((col) => (
                    <ColumnHeader
                      key={col.key}
                      col={col}
                      dir={columnSort?.key === col.key ? columnSort.dir : null}
                      onSort={() => cycleSort(col.key)}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((r) => (
                  <tr key={r.userId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                      {r.crewCode ?? "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium">{r.displayName}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.teamName ?? "-"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.schoolName ?? "-"}</td>
                    <td className="px-3 py-2">
                      {r.progressLine ?? (
                        <span className="text-muted-foreground">미신청</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={cn(
                          "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                          r.result === "success"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700",
                        )}
                      >
                        {r.result === "success" ? "강화 성공" : "강화 실패"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                      {formatAppliedAt(r.appliedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
