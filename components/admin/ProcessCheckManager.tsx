"use client";

// /admin/processes/check/{hub} — 프로세스 체크 화면(이번 주 고정).
//
//   주차명 드롭다운(이번 주 N · read-only) + 상태창1(오늘/이번 주 + 체크 중/완료) |
//   로그창(행동 이력, 위=과거/아래=최신) +
//   [섹션.1] 액트 목록 테이블(발생 시점(필요) 순 · 상태 버튼 클릭 → 팝업, 선택 표시).
//
// ?org 기준 데이터 분기(UI 동일). 상태 저장 + 로그 기록까지 — point.check/user_weekly_points/
// snapshot/크롤링 무접촉(완료 트리거는 후속 Phase).

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";
import { PROCESS_HUB_LABEL, type ProcessHub } from "@/lib/adminProcessesTypes";
import ProcessCheckActDialog from "@/components/admin/ProcessCheckActDialog";
import {
  PROCESS_CHECK_LOG_ACTION_LABEL,
  emptyProcessCheckBoard,
  formatCheckDateTimeKo,
  formatCheckTodayCompact,
  isTeamBasedProcessHub,
  processCheckButtonClass,
  processCheckButtonLabel,
  processCheckLogActionClass,
  type ProcessCheckActRowDto,
  type ProcessCheckBoardDto,
} from "@/lib/adminProcessCheckTypes";

// 강조(빨강) span — 날짜/주차/체크 중/체크 완료.
function Red({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-red-600">{children}</span>;
}

export default function ProcessCheckManager({
  hub,
  // [섹션.1] 액트 목록 테이블 표시 여부. experience 는 이번 Phase 에서 섹션.0(상태/로그/진행현황)만.
  showActTable = true,
}: {
  hub: ProcessHub;
  showActTable?: boolean;
}) {
  const hubLabel = PROCESS_HUB_LABEL[hub];
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);

  const [board, setBoard] = useState<ProcessCheckBoardDto>(() =>
    emptyProcessCheckBoard(hub, org ?? ""),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date());
  // 열린 팝업 대상 액트(없으면 닫힘).
  const [dialogAct, setDialogAct] = useState<ProcessCheckActRowDto | null>(null);

  const reqRef = useRef(0);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const loadBoard = useCallback(async () => {
    if (!org) {
      setLoading(false);
      return;
    }
    const myReq = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/processes/check?hub=${hub}&org=${encodeURIComponent(org)}`);
      const json = await res.json().catch(() => ({}));
      if (myReq !== reqRef.current) return;
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setBoard(json.data as ProcessCheckBoardDto);
      setError(null);
    } catch (err) {
      if (myReq !== reqRef.current) return;
      setBoard(emptyProcessCheckBoard(hub, org));
      setError(err instanceof Error ? err.message : "조회에 실패했습니다");
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, [hub, org]);

  useEffect(() => {
    void (async () => {
      await loadBoard();
    })();
  }, [loadBoard]);

  // 로그 갱신 시 스크롤 하단(최신).
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [board.logs]);

  const { week, summary, acts, logs, teams } = board;
  const periodLabel = week?.periodLabel ?? "주차 정보 없음";
  const weekDisabled = !week?.weekId;
  const teamMode = isTeamBasedProcessHub(hub); // experience = 팀별 문장 / info = 허브 전체 1문장

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">프로세스 체크 · {hubLabel} 급</h1>
        <p className="text-sm text-muted-foreground">
          이번 주 [{hubLabel} 급] 프로세스 액트 체크 (조직: {org ?? "미지정"})
        </p>
      </div>

      {!org && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          조직(?org)이 지정되어야 합니다. 예: <code>/admin/processes/check/info?org=oranke</code>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <span className="whitespace-pre-line">{error}</span>
          <button type="button" onClick={() => setError(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 주차명 드롭다운 — 이번 주 N 고정(read-only). */}
      <div className="max-w-xs space-y-1">
        <label className="text-xs text-muted-foreground">주차명 (이번 주 · 변경 불가)</label>
        <div
          aria-disabled="true"
          aria-label="주차명"
          className="flex cursor-not-allowed items-center justify-between rounded-md border border-input bg-muted/50 px-3 py-2 text-sm"
        >
          <span className={cn(weekDisabled && "text-muted-foreground")}>{periodLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </div>

      {/* 상태창1 (좌) + 로그창 (우) */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">상태창</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              오늘은 <Red>{formatCheckTodayCompact(today)}</Red>
              이며, 이번 주는 [<Red>{periodLabel}</Red>] 입니다. (월 ~ 일)
            </p>
            {teamMode ? (
              /* 팀 구분 허브(experience) — 팀마다 1문장. */
              teams.length === 0 ? (
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground">
                  이 조직에 등록된 팀이 없습니다.
                </p>
              ) : (
                teams.map((tm) => (
                  <p
                    key={tm.teamId}
                    className={cn(
                      "rounded-md border px-3 py-2",
                      tm.isAllCompleted
                        ? "border-green-300 bg-green-50 text-green-800"
                        : "border-amber-300 bg-amber-50 text-amber-800",
                    )}
                  >
                    이번 주 [<Red>{periodLabel}</Red>] <Red>{tm.teamName}</Red> 팀의 [{hubLabel} 급]
                    프로세스 액트가{" "}
                    {tm.isAllCompleted ? (
                      <>
                        모두 ‘<Red>체크 완료</Red>’ 되었습니다.
                      </>
                    ) : (
                      <>
                        ‘<Red>체크 중</Red>’ 에 있습니다.
                      </>
                    )}
                  </p>
                ))
              )
            ) : (
              /* 허브 전체 1문장(info 등) — 회귀 금지. */
              <p
                className={cn(
                  "rounded-md border px-3 py-2",
                  summary.isAllCompleted
                    ? "border-green-300 bg-green-50 text-green-800"
                    : "border-amber-300 bg-amber-50 text-amber-800",
                )}
              >
                이번 주 [<Red>{periodLabel}</Red>] [{hubLabel} 급] 프로세스 액트가{" "}
                {summary.isAllCompleted ? (
                  <>
                    모두 ‘<Red>체크 완료</Red>’ 되었습니다.
                  </>
                ) : (
                  <>
                    ‘<Red>체크 중</Red>’ 에 있습니다.
                  </>
                )}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">로그창</CardTitle>
          </CardHeader>
          <CardContent ref={logScrollRef} className="max-h-72 flex-1 space-y-1.5 overflow-y-auto text-sm">
            {loading ? (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
              </p>
            ) : logs.length === 0 ? (
              <p className="text-muted-foreground">아직 기록된 체크 로그가 없습니다.</p>
            ) : (
              logs.map((l) => (
                <p key={l.id} className="text-[13px] leading-relaxed">
                  <span className={cn("font-semibold", processCheckLogActionClass(l.action))}>
                    [{PROCESS_CHECK_LOG_ACTION_LABEL[l.action]}]
                  </span>{" "}
                  [{l.periodLabel}]
                  {l.teamName ? ` - ${l.teamName} 팀 -` : ""} [{l.lineGroupName}] {l.actName} -{" "}
                  {l.actorName} 님 - {formatLogDateTime(l.createdAt)}
                </p>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* [섹션.1] 액트 목록 테이블 — experience 는 이번 Phase 에서 미표시(섹션.0만). */}
      {showActTable && (
      <Card>
        <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">[섹션.1] 액트 목록 ({acts.length})</CardTitle>
          <p className="text-xs text-muted-foreground">
            발생 시점(필요) 순 · 상태 버튼 클릭 시 체크 신청/취소 팝업
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
          ) : acts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              등록된 액트가 없습니다. 프로세스 등록 페이지에서 먼저 등록해주세요.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>액트명</TableHead>
                    <TableHead>소속 라인 급</TableHead>
                    <TableHead className="text-right">소요(m)</TableHead>
                    <TableHead>발생 시점(필요)</TableHead>
                    <TableHead>체크 시점(필요)</TableHead>
                    <TableHead className="text-right">Po.A</TableHead>
                    <TableHead className="text-right">Po.B</TableHead>
                    <TableHead className="text-right">Po.C</TableHead>
                    <TableHead>크루 반응</TableHead>
                    <TableHead>카페</TableHead>
                    <TableHead>발생 시점(실제)</TableHead>
                    <TableHead>체크 시점(실제)</TableHead>
                    <TableHead className="text-right">상태</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acts.map((a) => (
                    <TableRow key={a.actId}>
                      <TableCell className="font-medium">{a.actName}</TableCell>
                      <TableCell>{a.lineGroupName}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.durationMinutes}</TableCell>
                      <TableCell className="whitespace-nowrap">{a.occurWhen}</TableCell>
                      <TableCell className="whitespace-nowrap">{a.checkWhen}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointCheck}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointAdvantage}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.pointPenalty}</TableCell>
                      <TableCell>{a.crewReactionLabel}</TableCell>
                      <TableCell>{a.cafeLabel}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {a.requestedAt ? formatCheckDateTimeKo(a.requestedAt) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {a.scheduledCheckAt ? formatCheckDateTimeKo(a.scheduledCheckAt) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {a.isCheckTarget ? (
                          <button
                            type="button"
                            disabled={weekDisabled}
                            title={weekDisabled ? "현재 주차 weeks 행 없음" : "클릭하여 체크 신청/취소"}
                            onClick={() => setDialogAct(a)}
                            className={cn(
                              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                              processCheckButtonClass(a.status),
                            )}
                          >
                            {processCheckButtonLabel(a.status)}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">체크 대상 아님</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {dialogAct && org && (
        <ProcessCheckActDialog
          act={dialogAct}
          hub={hub}
          organization={org}
          onClose={() => setDialogAct(null)}
          onDone={() => void loadBoard()}
        />
      )}
    </div>
  );
}
