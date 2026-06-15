"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
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

// 크루별 라인 개설 결과 행 (competency/applications DTO 의 results).
type CrewResult = {
  userId: string;
  crewNo: number | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  progressLine: string | null;
  result: "success" | "fail";
  appliedAt: string | null;
  applied: boolean;
};

// 신청 시간 표기 — KST 기준 "26.07.06(월), 21:52". 미신청('-').
function formatAppliedAt(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const kst = new Date(d.getTime() + 9 * 3600 * 1000); // UTC+9 시프트 후 getUTC* 로 KST 성분 추출
  const yy = String(kst.getUTCFullYear()).slice(2);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const dow = "일월화수목금토"[kst.getUTCDay()];
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${yy}.${mm}.${dd}(${dow}), ${hh}:${mi}`;
}

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
  // 운영/테스트 모드 — 집계/결과 모집단을 현재 모드로 한정.
  const mode = readScopeMode(searchParams);

  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [weeksReady, setWeeksReady] = useState(false);
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [results, setResults] = useState<CrewResult[]>([]);
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
  }, [org, mode, selectedWeekId, weeksReady, refreshKey]);

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

      {/* 선택 주차의 [실무 역량] 크루별 라인 개설 결과 표 (집계 카드와 동일 DTO 의 results) */}
      <div className="rounded-lg border">
        <div className="border-b bg-muted/30 px-4 py-2 text-sm font-semibold">
          크루별 라인 개설 결과
          {selectedWeek
            ? ` — ${formatBannerPeriod({
                year: selectedWeek.year,
                seasonName: selectedWeek.seasonName,
                weekNumber: selectedWeek.weekNumber,
              })}`
            : ""}
        </div>
        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> 불러오는 중…
          </p>
        ) : results.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            해당 주차의 활동 대상 크루가 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">크루 번호</th>
                  <th className="px-3 py-2 font-medium">크루명</th>
                  <th className="px-3 py-2 font-medium">소속 팀</th>
                  <th className="px-3 py-2 font-medium">학교</th>
                  <th className="px-3 py-2 font-medium">진행 라인</th>
                  <th className="px-3 py-2 font-medium">라인 결과</th>
                  <th className="px-3 py-2 font-medium">신청 시간</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.userId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                      {r.crewNo != null ? String(r.crewNo).padStart(4, "0") : "-"}
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
