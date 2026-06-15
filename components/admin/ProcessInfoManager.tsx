"use client";

// /admin/processes/info — 통합 > 허브별 프로세스 > 프로세스(액트) 정보 (조회/삭제 Phase).
//
// /admin/processes/register 에서 등록한 process_line_groups · process_acts 를 허브별로 조회한다.
// 이 화면은 마스터 조회 + 액트 삭제만 수행 — 라인급 삭제 차단 로직, snapshot, 주차 성장 계산,
// point.check 계산은 일절 건드리지 않는다. 요약 SoT = GET /api/admin/processes/info(서버 계산).
// 정렬/필터/페이지네이션은 표시용(클라이언트) — 요약 수치는 허브 전체 기준(필터 무관).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
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
import {
  PROCESS_ACT_TYPE_LABEL,
  PROCESS_CAFE_LABEL,
  PROCESS_CHECK_TARGET_LABEL,
  PROCESS_HUBS,
  PROCESS_HUB_LABEL,
  formatProcessWhen,
  type ProcessActDto,
  type ProcessActSummary,
  type ProcessHub,
  type ProcessPointTriplet,
} from "@/lib/adminProcessesTypes";

type Banner = { kind: "success" | "error"; message: string } | null;

const SELECT_CLS = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const PAGE_SIZE = 40;

const EMPTY_SUMMARY: ProcessActSummary = {
  actCount: 0,
  lineGroupCount: 0,
  totalDurationMinutes: 0,
  required: { check: 0, advantage: 0, penalty: 0 },
  excellent: { check: 0, advantage: 0, penalty: 0 },
  max: { check: 0, advantage: 0, penalty: 0 },
};

// 정렬 — 신청 시점 순(기본) / 소요 시간 순.
type SortKey = "occur" | "duration";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "occur", label: "신청 시점 순" },
  { key: "duration", label: "소요 시간 순" },
];

// 필터 — 종류(필수/선택/선발/기본) + 체크 대상(체크) + 카페(포스팅).
type FilterKey = "all" | "required" | "optional" | "selection" | "basic" | "check" | "posting";
const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "required", label: "필수" },
  { key: "optional", label: "선택" },
  { key: "selection", label: "선발" },
  { key: "basic", label: "기본" },
  { key: "check", label: "체크" },
  { key: "posting", label: "포스팅" },
];

function matchFilter(a: ProcessActDto, f: FilterKey): boolean {
  switch (f) {
    case "all":
      return true;
    case "required":
    case "optional":
    case "selection":
    case "basic":
      return a.actType === f;
    case "check":
      return a.checkTarget === "check";
    case "posting":
      return a.cafe === "occur";
    default:
      return true;
  }
}

const weekRank = (w: string) => (w === "N" ? 0 : 1);

// 표시용 식별번호 — process_acts.id(UUID) 앞 8자리. 사용자 수정 불가·등록 시 자동 생성(UUID).
const shortActId = (id: string) => id.slice(0, 8);

const fmtTrip = (t: ProcessPointTriplet) => `A ${t.check} | B ${t.advantage} | C ${t.penalty}`;

// 페이지 번호 목록(말줄임 포함).
function pageItems(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | "...")[] = [1];
  if (current > 3) items.push("...");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) items.push(i);
  if (current < total - 2) items.push("...");
  items.push(total);
  return items;
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export default function ProcessInfoManager() {
  const [activeHub, setActiveHub] = useState<ProcessHub>("club");
  const [banner, setBanner] = useState<Banner>(null);
  const [loading, setLoading] = useState(false);
  const [acts, setActs] = useState<ProcessActDto[]>([]);
  const [summary, setSummary] = useState<ProcessActSummary>(EMPTY_SUMMARY);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("occur");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [page, setPage] = useState(1);

  // 최신 요청 가드 — 빠른 탭 전환 시 늦게 도착한 이전 허브 응답이 최신 데이터를 덮어쓰지 않게 한다.
  const reqRef = useRef(0);

  const loadInfo = useCallback(async (hub: ProcessHub) => {
    const myReq = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/processes/info?hub=${hub}`);
      const json = await res.json().catch(() => ({}));
      if (myReq !== reqRef.current) return; // 더 최신 요청이 있으면 폐기
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setActs((json.data?.acts ?? []) as ProcessActDto[]);
      setSummary((json.data?.summary ?? EMPTY_SUMMARY) as ProcessActSummary);
    } catch (err) {
      if (myReq !== reqRef.current) return;
      setActs([]);
      setSummary(EMPTY_SUMMARY);
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "조회에 실패했습니다" });
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, []);

  // 허브 전환 → 재조회 + 정렬/필터/페이지 초기화.
  useEffect(() => {
    void loadInfo(activeHub);
    setSortKey("occur");
    setFilter("all");
    setPage(1);
  }, [activeHub, loadInfo]);

  // 정렬/필터 변경 시 1페이지로(페이지 변경 자체는 정렬/필터 유지).
  useEffect(() => {
    setPage(1);
  }, [sortKey, filter]);

  const handleTabChange = useCallback((hub: ProcessHub) => {
    setBanner(null);
    setActiveHub(hub);
  }, []);

  // 필터 + 정렬 적용(표시용). 요약은 허브 전체 기준 유지.
  const visibleActs = useMemo(() => {
    const filtered = acts.filter((a) => matchFilter(a, filter));
    const sorted = [...filtered];
    if (sortKey === "duration") {
      sorted.sort((a, b) => a.durationMinutes - b.durationMinutes);
    } else {
      // 신청 시점 순: occur_week(N→N+1) → occur_dow(일~토) → occur_time(오름차순)
      sorted.sort(
        (a, b) =>
          weekRank(a.occurWeek) - weekRank(b.occurWeek) ||
          a.occurDow - b.occurDow ||
          a.occurTime.localeCompare(b.occurTime),
      );
    }
    return sorted;
  }, [acts, filter, sortKey]);

  const pageCount = Math.max(1, Math.ceil(visibleActs.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => visibleActs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visibleActs, safePage],
  );

  const handleDelete = useCallback(
    async (act: ProcessActDto) => {
      if (!window.confirm(`액트 "${act.actName}" 을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
      setDeletingId(act.id);
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/processes/acts/${act.id}`, { method: "DELETE" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        await loadInfo(activeHub); // 목록/요약 즉시 갱신(요약 서버 재계산)
        setBanner({ kind: "success", message: `액트가 삭제되었습니다 (${act.actName})` });
      } catch (err) {
        setBanner({ kind: "error", message: err instanceof Error ? err.message : "삭제에 실패했습니다" });
      } finally {
        setDeletingId(null);
      }
    },
    [activeHub, loadInfo],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      {/* 헤더 탭 (5개 허브급 — 등록 페이지와 동일) */}
      <div className="flex flex-wrap gap-1 border-b">
        {PROCESS_HUBS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => handleTabChange(h)}
            className={cn(
              "rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
              activeHub === h
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {PROCESS_HUB_LABEL[h]} 급
          </button>
        ))}
      </div>

      {banner && (
        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          <span className="whitespace-pre-line">{banner.message}</span>
          <button type="button" onClick={() => setBanner(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 상단 요약 — 2열 × 3행 (좌: 액트/라인급/소요 · 우: 필수/우수/최대 포인트).
          설명 문구 없이 탭 바로 아래에 요약만 표시. */}
      <div className="grid grid-cols-1 gap-x-12 rounded-lg border bg-muted/30 px-4 py-2 md:grid-cols-2">
        <div>
          <SummaryRow label="산하 액트 수" value={`${summary.actCount}개`} />
          <SummaryRow label="산하 라인급 수" value={`${summary.lineGroupCount}개`} />
          <SummaryRow label="총합 소요 시간" value={`${summary.totalDurationMinutes}m`} />
        </div>
        <div>
          <SummaryRow label="필수 포인트 총합" value={fmtTrip(summary.required)} />
          <SummaryRow label="우수 포인트 총합" value={fmtTrip(summary.excellent)} />
          <SummaryRow label="최대 포인트 총합" value={fmtTrip(summary.max)} />
        </div>
      </div>

      {/* 액트 목록 */}
      <Card>
        {/* 좌측: 정렬/필터 컨트롤 · 우측: 현재 필터/탭 조건 반영 결과 수(페이지 무관 전체). */}
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              정렬
              <select
                aria-label="정렬"
                className={SELECT_CLS}
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              필터
              <select
                aria-label="필터"
                className={SELECT_CLS}
                value={filter}
                onChange={(e) => setFilter(e.target.value as FilterKey)}
              >
                {FILTER_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="text-sm font-medium text-muted-foreground">
            결과 수 {visibleActs.length}개
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중...</p>
          ) : pageRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {acts.length === 0
                ? "등록된 액트가 없습니다. 프로세스 등록 페이지에서 먼저 등록해주세요."
                : "필터 조건에 맞는 액트가 없습니다."}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">번호</TableHead>
                    <TableHead>액트명</TableHead>
                    <TableHead>소속 라인 급</TableHead>
                    <TableHead className="text-right">소요(m)</TableHead>
                    <TableHead>신청 시점</TableHead>
                    <TableHead>검수 시점</TableHead>
                    <TableHead className="text-right">Po.A</TableHead>
                    <TableHead className="text-right">Po.B</TableHead>
                    <TableHead className="text-right">Po.C</TableHead>
                    <TableHead>크루 반응</TableHead>
                    <TableHead>체크 대상</TableHead>
                    <TableHead>카페</TableHead>
                    <TableHead className="text-right">삭제</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground" title={a.id}>
                        {shortActId(a.id)}
                      </TableCell>
                      <TableCell className="font-medium">{a.actName}</TableCell>
                      <TableCell>{a.lineGroupName ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.durationMinutes}</TableCell>
                      <TableCell>{formatProcessWhen(a.occurWeek, a.occurDow, a.occurTime)}</TableCell>
                      <TableCell>{formatProcessWhen(a.checkWeek, a.checkDow, a.checkTime)}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointCheck}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointAdvantage}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointPenalty}</TableCell>
                      <TableCell>{PROCESS_ACT_TYPE_LABEL[a.actType]}</TableCell>
                      <TableCell>{PROCESS_CHECK_TARGET_LABEL[a.checkTarget]}</TableCell>
                      <TableCell>{PROCESS_CAFE_LABEL[a.cafe]}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                          disabled={deletingId === a.id}
                          onClick={() => void handleDelete(a)}
                        >
                          {deletingId === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "삭제"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* 페이지네이션 — 40개 기준 */}
              {pageCount > 1 && (
                <div className="flex items-center justify-center gap-1 pt-2" aria-label="페이지네이션">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="이전 페이지"
                  >
                    ‹
                  </Button>
                  {pageItems(safePage, pageCount).map((it, i) =>
                    it === "..." ? (
                      <span key={`e${i}`} className="px-2 text-sm text-muted-foreground">
                        …
                      </span>
                    ) : (
                      <Button
                        key={it}
                        type="button"
                        variant={it === safePage ? "default" : "outline"}
                        size="sm"
                        className="min-w-9"
                        aria-label={`${it} 페이지`}
                        aria-current={it === safePage ? "page" : undefined}
                        onClick={() => setPage(it)}
                      >
                        {it}
                      </Button>
                    ),
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    aria-label="다음 페이지"
                  >
                    ›
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
