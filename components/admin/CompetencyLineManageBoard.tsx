"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  formatBannerPeriod,
  formatFullDateRangeKo,
} from "@/lib/practicalInfoSection0Format";
import PracticalInfoCurrentSituation from "@/components/admin/PracticalInfoCurrentSituation";

// 실무 역량 [라인 관리] 탭 — 상단 보드.
//   "[실무 역량] Hub" 제목 + 현재 상황(오늘/개설 필요/개설 이행 기간, practical-info 공용) +
//   주차 드롭다운(좌) + 6 집계 카드(우). 집계는 라인 개설 탭과 동일 DTO(competency/applications)
//   를 주차만 바꿔(week_id) 조회 → 같은 주차면 값 일치. snapshot 무관(읽기 전용).

type WeekOption = {
  id: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  canOpen: boolean;
  isOpenTarget: boolean;
  isCurrent: boolean;
};

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

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "default" | "info" | "success" | "error";
}) {
  return (
    <div
      className={cn(
        "min-w-[78px] rounded-md border px-4 py-2 text-center",
        tone === "info" && "border-blue-200 bg-blue-50",
        tone === "success" && "border-green-200 bg-green-50",
        tone === "error" && "border-red-200 bg-red-50",
        (!tone || tone === "default") && "border-gray-200 bg-gray-50",
      )}
    >
      <p className="text-xl font-bold leading-none">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
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

  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [weeksReady, setWeeksReady] = useState(false);
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 주차 옵션 부트스트랩 — practical-info/experience 와 동일 SoT(weeks-options).
  // 기본 선택 = openable(개설 대상, 금요일 경계 isOpenTarget) → 현재 → 첫 옵션.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/cluster4/weeks-options?limit=8");
        const json = await res.json();
        if (cancelled) return;
        const opts: WeekOption[] = json?.success ? json.data?.weeks ?? [] : [];
        setWeekOptions(opts);
        const def =
          opts.find((o) => o.isOpenTarget) ??
          opts.find((o) => o.isCurrent) ??
          opts[0];
        setSelectedWeekId((prev) => prev || (def?.id ?? ""));
      } catch {
        /* 폴백: week_id 없이 개설 대상 기본 경로 */
      } finally {
        if (!cancelled) setWeeksReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    let cancelled = false;
    void (async () => {
      if (!cancelled) setLoading(true);
      try {
        const qs = new URLSearchParams({ organization: org });
        if (selectedWeekId) qs.set("week_id", selectedWeekId);
        const res = await fetch(
          `/api/admin/cluster4/competency/applications?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        setSummary(json?.success ? (json.data?.summary ?? EMPTY) : EMPTY);
      } catch {
        if (!cancelled) setSummary(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, selectedWeekId, weeksReady, refreshKey]);

  const selectedWeek = weekOptions.find((w) => w.id === selectedWeekId) ?? null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">[실무 역량] Hub</h1>

      {/* 오늘 날짜 / 개설 필요 기간 / 개설 이행 기간 (practical-info 공용·동일 SoT) */}
      <PracticalInfoCurrentSituation />

      {/* 주차 선택(좌) + 6 집계 카드(우) — 한 행 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
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
                    {formatFullDateRangeKo(w.startDate, w.endDate)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {loading ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 집계 불러오는 중…
            </span>
          ) : (
            <>
              <StatCard label="활동 크루" value={summary.activeCrews} />
              <StatCard label="신청 크루" value={summary.appliedCrews} tone="info" />
              <StatCard label="개설 크루" value={summary.openedCrews} tone="success" />
              <StatCard label="반려 크루" value={summary.rejectedCrews} tone="error" />
              <StatCard label="신청 라인" value={summary.appliedLines} tone="info" />
              <StatCard label="개설 라인" value={summary.openedLines} tone="success" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
