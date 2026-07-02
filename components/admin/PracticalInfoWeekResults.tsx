"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatClubDateTime } from "@/lib/clubDate";
import {
  computeOpenNeed,
  weekName,
  weekRange,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";
import { buildLineManageWeekRows } from "@/lib/lineManageWeekOptions";

// 부모(PracticalInfoManager)로 끌어올린 선택 주차 SoT 를 표시용으로 되돌려주기 위한 메타.
//   weekId 단일 SoT 외에, "신규 개설 주차" 라벨이 weeks-options(최근 N주) 밖 주차(예: 과거 W16)도
//   정확히 표기할 수 있도록 season-weeks 행에서 라벨/기간을 함께 보고한다.
export type SelectedInfoWeekMeta = {
  weekId: string;
  label: string;
  startDate: string | null;
  endDate: string | null;
};
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  INFO_CREW_EDIT_POLICY_LABEL,
  isInfoCrewEditableWeek,
} from "@/lib/cluster4InfoCrewEditWindow";
import PracticalInfoCrewEditModal from "@/components/admin/PracticalInfoCrewEditModal";

// 실무 정보 — "주차별 개설 결과" (표시 전용 · read-only API).
//   주차 드롭다운(미래 주차 제외, 기본값=개설 필요 기간) + 요약 카운트 + 라인별 개설 상황 카드.

type LineStatus = "opened" | "needs_opening" | "not_open";
type LineResult = {
  activityTypeId: string;
  lineName: string;
  lineId: string | null;
  status: LineStatus;
  openedAt: string | null;
  mainTitle: string | null;
  openedByName: string | null;
  targetCount: number | null;
  secondInputCount: number | null;
};
type Results = {
  weekId: string;
  weekLabel: string;
  weekPeriod: string;
  weekStartDate: string | null;
  weekEndDate: string | null;
  openLineCount: number;
  openedLineCount: number;
  lines: LineResult[];
};

// "26 - 07 - 06 (월) 17:23" — 개설 시점(KST).
function fmtOpenedAt(iso: string | null): string {
  return formatClubDateTime(iso);
}

const STATUS_META: Record<
  LineStatus,
  { label: string; cls: string }
> = {
  opened: { label: "개설 완료", cls: "border-green-300 bg-green-50 text-green-800" },
  needs_opening: { label: "개설 필요", cls: "border-amber-300 bg-amber-50 text-amber-800" },
  not_open: { label: "오픈 없음", cls: "border-border bg-muted text-muted-foreground" },
};

export default function PracticalInfoWeekResults({
  selectedWeekId,
  onSelectWeek,
  onWeekMetaResolved,
}: {
  // 선택 주차 단일 SoT — 부모(PracticalInfoManager)가 소유한다.
  //   이 드롭다운이 manage 탭의 유일한 주차 선택 컨트롤이며, 변경 시 부모 state 를 갱신해
  //   "신규 개설 주차" 라벨·라인 목록·탭 dot·API 파라미터가 모두 같은 weekId 를 쓰게 한다.
  selectedWeekId: string;
  onSelectWeek: (weekId: string) => void;
  onWeekMetaResolved: (meta: SelectedInfoWeekMeta | null) => void;
}) {
  const [weeks, setWeeks] = useState<SeasonWeekRow[] | null>(null);
  const [weeksError, setWeeksError] = useState<string | null>(null);

  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "개설 대상 크루 수정" 모달 대상 라인. null = 닫힘.
  const [editTarget, setEditTarget] = useState<LineResult | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);

  // 1. season-weeks 조회 → 개설 필요 주차 계산 → 기본 선택 + 드롭다운 옵션 구성.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/season-weeks");
        const json = await res.json();
        if (cancelled) return;
        if (!json?.success) {
          setWeeksError(json?.error ?? "주차 정보를 불러오지 못했습니다");
          return;
        }
        const rows = (json.data?.rows ?? []) as SeasonWeekRow[];
        setWeeks(rows);
        // 기본 선택 주차는 부모(PracticalInfoManager)가 weeks-options 의 isOpenTarget(금요일 경계,
        // 서버 강제와 동일 함수)으로 단일하게 정한다 → 여기서는 default 를 set 하지 않는다(이중 default 제거).
      } catch {
        if (!cancelled) setWeeksError("주차 정보를 불러오지 못했습니다");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 드롭다운 옵션 — 미래 주차 제외(가장 최신 = 개설 필요 기간 주차), 최신순.
  //   0주차·시즌 최대 초과(전환 주차 17/9 등)는 라인 개설 대상이 아니므로 필터에서 제외.
  //   실무 경험/역량 라인 관리 드롭다운과 동일 SoT(buildLineManageWeekRows 공용).
  const options = useMemo(
    () => (weeks ? buildLineManageWeekRows(weeks, selectedWeekId) : []),
    [weeks, selectedWeekId],
  );

  // 선택 주차(SoT) → 표시용 메타를 부모로 보고. "신규 개설 주차" 라벨이 weeks-options(최근 N주)
  // 범위 밖 주차도 정확히 표기할 수 있게 한다(라인 목록과 라벨이 항상 같은 주차를 가리키도록).
  useEffect(() => {
    if (!weeks || !selectedWeekId) {
      onWeekMetaResolved(null);
      return;
    }
    const row = weeks.find((w) => w.week_id === selectedWeekId);
    onWeekMetaResolved(
      row
        ? {
            weekId: selectedWeekId,
            label: weekName(row),
            startDate: row.week_start_date ?? null,
            endDate: row.week_end_date ?? null,
          }
        : null,
    );
  }, [weeks, selectedWeekId, onWeekMetaResolved]);

  // 선택 주차 개설 결과 조회 — 최초 로드 + 크루 수정 저장 후 재조회 공용.
  const fetchResults = useCallback(async (weekId: string) => {
    if (!weekId) return;
    setLoading(true);
    setError(null);
    try {
      // 조직 컨텍스트(?org)를 내부 API 컨벤션(organization)으로 전달 — PracticalInfoManager 와 동일.
      // 조직 모드면 (해당 조직 OR 공통) 라인만, 통합 모드(org 없음)면 전체.
      const org = readOrgParam(new URLSearchParams(window.location.search));
      const qs = new URLSearchParams({ week_id: weekId });
      if (org) qs.set("organization", org);
      // ⚠ QA 누수 차단: 주차별 개설 결과 목록도 mode 전달 — 미전달=operating(운영 라인) 노출.
      const res = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/info-line-results?${qs.toString()}`,
          readScopeMode(new URLSearchParams(window.location.search)),
        ),
      );
      const json = await res.json();
      if (json?.success) setResults(json.data as Results);
      else {
        setResults(null);
        setError(json?.error ?? "개설 결과를 불러오지 못했습니다");
      }
    } catch {
      setResults(null);
      setError("개설 결과를 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  // 2. 선택 주차 → 개설 결과 조회. (setTimeout(0) 로 비동기 분리 — effect 동기 setState 회피)
  useEffect(() => {
    if (!selectedWeekId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) void fetchResults(selectedWeekId);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [selectedWeekId, fetchResults]);

  // 선택 주차가 "개설 대상 크루 수정" 가능한지 — 정책: 이미 종료된 과거 주차만(현재/미래 불가).
  const weekEditable = useMemo(
    () => isInfoCrewEditableWeek(results?.weekStartDate, results?.weekEndDate),
    [results?.weekStartDate, results?.weekEndDate],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-lg">주차별 개설 결과</CardTitle>
          <CardDescription>
            선택 주차의 실무 정보 라인 개설 상황. (미래 주차 제외 · 기본값=개설 필요 기간)
          </CardDescription>
        </div>
        <select
          aria-label="개설 결과 주차 선택"
          className="rounded-md border border-input bg-background px-3 py-2 text-base"
          value={selectedWeekId}
          onChange={(e) => onSelectWeek(e.target.value)}
          disabled={!weeks || options.length === 0}
        >
          {options.length === 0 && <option value="">주차 없음</option>}
          {options.map((w) => (
            <option key={w.week_id} value={w.week_id}>
              {weekName(w)} ({weekRange(w)})
            </option>
          ))}
        </select>
      </CardHeader>
      <CardContent className="space-y-4">
        {weeksError ? (
          <p className="text-base text-red-600">{weeksError}</p>
        ) : !weeks ? (
          <LoadingState active />
        ) : (
          <>
            {/* 요약 카운트 */}
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-base">
                <span className="text-muted-foreground">오픈 라인</span>{" "}
                <span className="font-semibold">{results?.openLineCount ?? "-"}</span>
              </div>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-base">
                <span className="text-muted-foreground">개설 라인</span>{" "}
                <span className="font-semibold">{results?.openedLineCount ?? "-"}</span>
              </div>
            </div>

            {/* 크루 수정 결과 배너 */}
            {savedBanner && (
              <div className="flex items-start justify-between gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
                <span>{savedBanner}</span>
                <button type="button" onClick={() => setSavedBanner(null)}>
                  ✕
                </button>
              </div>
            )}

            {/* 수정 불가 안내 — 개설 라인이 있는데 아직 종료 전(진행 중/예정) 주차면 표시. */}
            {results &&
              !weekEditable &&
              results.lines.some((l) => l.status === "opened") && (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  이 주차는 아직 종료되지 않아(진행 중/예정) 개설 대상 크루 수정 버튼이
                  표시되지 않습니다. ({INFO_CREW_EDIT_POLICY_LABEL})
                </p>
              )}

            {error ? (
              <p className="text-base text-red-600">{error}</p>
            ) : loading ? (
              <LoadingState active variant="inline" title="개설 결과 불러오는 중…" />
            ) : !results ? (
              <p className="text-base text-muted-foreground">표시할 주차를 선택해주세요.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {results.lines.map((l) => {
                  const meta = STATUS_META[l.status];
                  return (
                    <div
                      key={l.activityTypeId}
                      className="space-y-2 rounded-md border p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-base font-semibold">{l.lineName}</span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-sm font-medium",
                            meta.cls,
                          )}
                        >
                          {meta.label}
                        </span>
                      </div>
                      {l.status === "opened" ? (
                        <>
                          <dl className="space-y-1 text-sm">
                            <Row label="개설 시점" value={fmtOpenedAt(l.openedAt)} />
                            <Row label="메인 타이틀" value={l.mainTitle ?? "-"} wrap />
                            <Row label="개설자" value={l.openedByName ?? "-"} />
                            <Row label="개설 해당자" value={`${l.targetCount ?? 0}명`} />
                            <Row label="2차 기입자" value={`${l.secondInputCount ?? 0}명`} />
                          </dl>
                          {/* 개설 대상 크루 수정 — 허용 범위 주차 + lineId 존재 시에만 노출. */}
                          {l.lineId && weekEditable && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-1 w-full"
                              onClick={() => {
                                setSavedBanner(null);
                                setEditTarget(l);
                              }}
                            >
                              <Users className="mr-1.5 h-3.5 w-3.5" /> 개설 대상 크루 수정
                            </Button>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {l.status === "needs_opening"
                            ? "아직 개설되지 않았습니다."
                            : "이번 주차 오픈 대상이 아닙니다."}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* 개설 대상 크루 수정 모달 */}
      {editTarget && editTarget.lineId && results && (
        <PracticalInfoCrewEditModal
          lineId={editTarget.lineId}
          weekId={results.weekId}
          activityTypeId={editTarget.activityTypeId}
          lineName={editTarget.lineName}
          weekLabel={results.weekLabel}
          mainTitle={editTarget.mainTitle}
          onClose={() => setEditTarget(null)}
          onSaved={(message) => {
            setEditTarget(null);
            setSavedBanner(message);
            void fetchResults(selectedWeekId);
          }}
        />
      )}
    </Card>
  );
}

function Row({
  label,
  value,
  wrap,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 font-medium", wrap ? "break-words" : "truncate")}>
        {value}
      </dd>
    </div>
  );
}
