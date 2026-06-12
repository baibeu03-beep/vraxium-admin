"use client";

// /admin/processes/check/{hub} — 프로세스 체크 화면(이번 주 고정).
//
//   [섹션.0] 액트 관리(전체 팀 고정): 주차 드롭다운 + 상태창1(팀별/허브) + 로그창 + 상태창2(전체 팀).
//   [섹션.1] 액트 체크: info=단일 테이블 / experience=팀 탭 + 팀별 상태창2 + 팀별 액트 테이블.
//     팀 탭을 바꿔도 섹션.0은 고정 — 섹션.1(상태창2·액트 상태값)만 선택 팀 기준으로 갱신.
//
// ?org 기준 데이터 분기. 상태 저장 + 로그 기록까지 — point.check/user_weekly_points/snapshot/크롤링 무접촉.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";
import { PROCESS_HUB_LABEL, type ProcessHub } from "@/lib/adminProcessesTypes";
import ProcessCheckActDialog from "@/components/admin/ProcessCheckActDialog";
import ProcessCheckActTable from "@/components/admin/ProcessCheckActTable";
import ProcessCheckProgress from "@/components/admin/ProcessCheckProgress";
import {
  PROCESS_CHECK_LOG_ACTION_LABEL,
  emptyProcessCheckBoard,
  formatCheckTodayCompact,
  isTeamBasedProcessHub,
  processCheckLogActionClass,
  type ProcessCheckActRowDto,
  type ProcessCheckBoardDto,
} from "@/lib/adminProcessCheckTypes";

function Red({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-red-600">{children}</span>;
}

export default function ProcessCheckManager({ hub }: { hub: ProcessHub }) {
  const hubLabel = PROCESS_HUB_LABEL[hub];
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  const teamMode = isTeamBasedProcessHub(hub);

  // 섹션.0 보드(전체 팀·teamless). info 는 섹션.1 도 이 보드 사용.
  const [board, setBoard] = useState<ProcessCheckBoardDto>(() =>
    emptyProcessCheckBoard(hub, org ?? ""),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date());
  const [dialogAct, setDialogAct] = useState<ProcessCheckActRowDto | null>(null);

  // 섹션.1(experience) 팀 스코프 보드.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamBoard, setTeamBoard] = useState<ProcessCheckBoardDto>(() =>
    emptyProcessCheckBoard(hub, org ?? ""),
  );
  const [teamLoading, setTeamLoading] = useState(false);

  const reqRef = useRef(0);
  const teamReqRef = useRef(0);
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

  const loadTeamBoard = useCallback(
    async (teamId: string) => {
      if (!org) return;
      const myReq = ++teamReqRef.current;
      setTeamLoading(true);
      try {
        const res = await fetch(
          `/api/admin/processes/check?hub=${hub}&org=${encodeURIComponent(org)}&team=${encodeURIComponent(teamId)}`,
        );
        const json = await res.json().catch(() => ({}));
        if (myReq !== teamReqRef.current) return;
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        setTeamBoard(json.data as ProcessCheckBoardDto);
      } catch {
        if (myReq !== teamReqRef.current) return;
        setTeamBoard(emptyProcessCheckBoard(hub, org));
      } finally {
        if (myReq === teamReqRef.current) setTeamLoading(false);
      }
    },
    [hub, org],
  );

  useEffect(() => {
    void (async () => {
      await loadBoard();
    })();
  }, [loadBoard]);

  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [board.logs]);

  const { week, summary, acts, logs, teams } = board;
  const periodLabel = week?.periodLabel ?? "주차 정보 없음";
  const weekDisabled = !week?.weekId;

  // 선택 팀 — 명시 선택이 유효하면 그것, 아니면 첫 팀(설계상 첫 팀 기본 선택). setState-in-effect 회피.
  const effectiveTeamId = useMemo(() => {
    if (!teamMode) return null;
    if (selectedTeamId && teams.some((t) => t.teamId === selectedTeamId)) return selectedTeamId;
    return teams[0]?.teamId ?? null;
  }, [teamMode, selectedTeamId, teams]);
  const effectiveTeamName = teams.find((t) => t.teamId === effectiveTeamId)?.teamName ?? null;

  // 선택 팀 변경/로드 시 섹션.1 팀 보드 조회.
  useEffect(() => {
    if (!teamMode || !effectiveTeamId) return;
    void (async () => {
      await loadTeamBoard(effectiveTeamId);
    })();
  }, [teamMode, effectiveTeamId, loadTeamBoard]);

  // 액션 성공 후 — 섹션.0(로그/상태창) + 섹션.1(선택 팀 상태) 갱신.
  const refreshAfterAction = useCallback(() => {
    void loadBoard();
    if (teamMode && effectiveTeamId) void loadTeamBoard(effectiveTeamId);
  }, [loadBoard, loadTeamBoard, teamMode, effectiveTeamId]);

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
          조직(?org)이 지정되어야 합니다. 예: <code>/admin/processes/check/experience?org=oranke</code>
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

      {/* ════ [섹션.0] 액트 관리 — 전체 팀 고정 ════ */}
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

      {/* 상태창2 — 전체 팀(섹션.0 고정). */}
      <ProcessCheckProgress
        title={teamMode ? "상태창 2 · 이번 주 체크 진행 현황 (전체 팀)" : "상태창 2 · 이번 주 체크 진행 현황"}
        summary={summary}
        lineGroups={board.lineGroups}
      />

      {/* ════ [섹션.1] 액트 체크 ════ */}
      {teamMode ? (
        <div className="flex flex-col gap-4">
          {/* 팀 탭 — org 동적, 첫 팀 기본 선택. */}
          <div className="flex flex-wrap gap-1 border-b">
            {teams.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">등록된 팀이 없습니다.</p>
            ) : (
              teams.map((tm) => (
                <button
                  key={tm.teamId}
                  type="button"
                  onClick={() => setSelectedTeamId(tm.teamId)}
                  className={cn(
                    "rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
                    effectiveTeamId === tm.teamId
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tm.teamName} 팀
                </button>
              ))
            )}
          </div>

          {effectiveTeamId && (
            <>
              {/* 섹션.1 상태창2 — 선택 팀 기준. */}
              <ProcessCheckProgress
                title={`상태창 2 · ${effectiveTeamName ?? "선택 팀"} (선택 팀)`}
                summary={teamBoard.summary}
                lineGroups={teamBoard.lineGroups}
              />
              {/* 섹션.1 액트 목록 — 선택 팀 상태값. */}
              <ProcessCheckActTable
                acts={teamBoard.acts}
                loading={teamLoading}
                weekDisabled={weekDisabled}
                onOpenAct={(a) => setDialogAct(a)}
                title={`[섹션.1] 액트 목록 · ${effectiveTeamName ?? "선택 팀"}`}
              />
            </>
          )}
        </div>
      ) : (
        <ProcessCheckActTable
          acts={acts}
          loading={loading}
          weekDisabled={weekDisabled}
          onOpenAct={(a) => setDialogAct(a)}
        />
      )}

      {dialogAct && org && (
        <ProcessCheckActDialog
          act={dialogAct}
          hub={hub}
          organization={org}
          teamId={teamMode ? effectiveTeamId : null}
          onClose={() => setDialogAct(null)}
          onDone={refreshAfterAction}
        />
      )}
    </div>
  );
}
