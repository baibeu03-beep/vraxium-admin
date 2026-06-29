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
import { ChevronDown, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";
import { PROCESS_HUB_LABEL, type ProcessHub } from "@/lib/adminProcessesTypes";
import ProcessCheckActDialog from "@/components/admin/ProcessCheckActDialog";
import ProcessCheckActTable from "@/components/admin/ProcessCheckActTable";
import ProcessCheckManualGrantDialog from "@/components/admin/ProcessCheckManualGrantDialog";
import ProcessCheckProgress from "@/components/admin/ProcessCheckProgress";
import { WeekSelectRow } from "@/components/admin/WeekSelectRow";
import {
  PROCESS_CHECK_LOG_ACTION_LABEL,
  emptyProcessCheckBoard,
  formatCheckTodayCompact,
  isSelectionActType,
  isTeamBasedProcessHub,
  processCheckLogActionClass,
  type ProcessCheckActRowDto,
  type ProcessCheckBoardDto,
  type ProcessCheckScopeKind,
} from "@/lib/adminProcessCheckTypes";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";

function Red({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-red-600">{children}</span>;
}

// 어드민 공통 섹션 타이틀 — 모든 허브(info/experience/competency/club)가 공유.
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-base font-semibold tracking-tight text-foreground">{children}</h2>;
}

export default function ProcessCheckManager({ hub }: { hub: ProcessHub }) {
  const hubLabel = PROCESS_HUB_LABEL[hub];
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 팀 목록(섹션.1 팀 탭) 스코프 — operating=운영 팀만 / test=(T) 팀만. 토글 보존(appendModeQuery).
  const mode = readScopeMode(searchParams);
  const teamMode = isTeamBasedProcessHub(hub);

  // 섹션.0 보드(전체 팀·teamless). info 는 섹션.1 도 이 보드 사용.
  const [board, setBoard] = useState<ProcessCheckBoardDto>(() =>
    emptyProcessCheckBoard(hub, org ?? ""),
  );
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date());
  // 사용자가 선택한 주차(weeks.id). null = 현재 주차(서버 기본). 섹션.0/1 양쪽 동일 주차로 조회.
  const [weekParam, setWeekParam] = useState<string | null>(null);
  const [dialogAct, setDialogAct] = useState<ProcessCheckActRowDto | null>(null);
  // 선별 액트 "체크 필요" 클릭 시 [검수 링크]/[수동 입력] 선택 모달 + 수동 입력 모달.
  const [choiceAct, setChoiceAct] = useState<ProcessCheckActRowDto | null>(null);
  const [manualGrantAct, setManualGrantAct] = useState<ProcessCheckActRowDto | null>(null);

  // 액트 상태 버튼 클릭 — 팝업 라우팅:
  //   needed + 선별         → 선택 모달([검수 링크]/[수동 입력])
  //   completed + 수동 입력  → 수동 입력 팝업(체크 완료 크루 명단·읽기 전용)
  //   그 외(필수·검수 링크 진행/대기/완료) → 검수 링크 팝업
  const openAct = useCallback((a: ProcessCheckActRowDto) => {
    if (a.status === "needed" && isSelectionActType(a.actType)) {
      setChoiceAct(a);
    } else if (a.status === "completed" && a.completionType === "manual_grant") {
      setManualGrantAct(a);
    } else {
      setDialogAct(a);
    }
  }, []);

  // 섹션.1(experience) 팀 스코프 보드.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamBoard, setTeamBoard] = useState<ProcessCheckBoardDto>(() =>
    emptyProcessCheckBoard(hub, org ?? ""),
  );
  const [teamLoading, setTeamLoading] = useState(false);
  // 팀 & 파트 스코프 — "all"(팀 전체·읽기전용) / "overall"(팀 총괄) / <partLineGroupId>(파트).
  const [scopeValue, setScopeValue] = useState<string>("all");

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
      let url = `/api/admin/processes/check?hub=${hub}&org=${encodeURIComponent(org)}`;
      if (weekParam) url += `&week=${encodeURIComponent(weekParam)}`;
      const res = await fetch(appendModeQuery(url, mode));
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
  }, [hub, org, mode, weekParam]);

  // 섹션.1 팀 보드 — 서버가 스코프(team_all|team_overall|part)로 액트/요약/상태를 필터해 반환.
  //   teamParts(드롭다운)·selectedPart(크루 수)도 함께. 파트별 상태는 서버에서 part_name 으로 독립.
  const loadTeamBoard = useCallback(
    async (teamId: string, scopeKind: ProcessCheckScopeKind, partName: string | null) => {
      if (!org) return;
      const myReq = ++teamReqRef.current;
      setTeamLoading(true);
      try {
        let url = `/api/admin/processes/check?hub=${hub}&org=${encodeURIComponent(org)}&team=${encodeURIComponent(teamId)}&scope=${scopeKind}`;
        if (scopeKind === "part" && partName) url += `&part=${encodeURIComponent(partName)}`;
        if (weekParam) url += `&week=${encodeURIComponent(weekParam)}`;
        const res = await fetch(appendModeQuery(url, mode));
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
    [hub, org, mode, weekParam],
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

  const { week, selectedWeek, summary, acts, logs, teams, weeks, selectedWeekId, editable } = board;
  const displayWeek = selectedWeek ?? week;
  const weekName = displayWeek?.weekName ?? displayWeek?.periodLabel ?? "주차 정보 없음";
  const periodLabel = displayWeek?.periodLabel ?? weekName;
  // 과거 주차(editable=false) = 조회 전용 → 섹션.0/1 모든 쓰기 버튼 비활성(weekDisabled).
  const weekDisabled = !editable;
  // 드롭다운 표시값 — 사용자가 막 고른 값(weekParam) 우선, 없으면 서버 선택값.
  const selValue = weekParam ?? selectedWeekId ?? "";
  // 섹션.1(팀 보드)도 동일 선택 주차 → 같은 editable 축으로 쓰기 가드(미로드 시 보수적으로 비활성).
  const teamWeekDisabled = !teamBoard.editable;

  // 선택 팀 — 명시 선택이 유효하면 그것, 아니면 첫 팀(설계상 첫 팀 기본 선택). setState-in-effect 회피.
  const effectiveTeamId = useMemo(() => {
    if (!teamMode) return null;
    if (selectedTeamId && teams.some((t) => t.teamId === selectedTeamId)) return selectedTeamId;
    return teams[0]?.teamId ?? null;
  }, [teamMode, selectedTeamId, teams]);
  const effectiveTeamName = teams.find((t) => t.teamId === effectiveTeamId)?.teamName ?? null;

  // 팀 & 파트 드롭다운 옵션 — 선택 팀의 실제 파트(user_memberships) · 서버 제공(teamParts).
  //   process_line_groups 가 아니라 실제 팀 구조가 출처 — 파트 라인급 미등록이어도 노출.
  const teamParts = teamBoard.teamParts;
  // 유효 스코프값 — 팀 전환/모드 변경으로 더 이상 없는 파트면 "all"(팀 전체)로 폴백(setState-in-effect 회피).
  const effectiveScopeValue = useMemo(() => {
    if (scopeValue === "all" || scopeValue === "overall") return scopeValue;
    return teamParts.includes(scopeValue) ? scopeValue : "all";
  }, [scopeValue, teamParts]);
  const scopeKind: ProcessCheckScopeKind =
    effectiveScopeValue === "all"
      ? "team_all"
      : effectiveScopeValue === "overall"
        ? "team_overall"
        : "part";
  const scopePartName = scopeKind === "part" ? effectiveScopeValue : null;
  const scopeLabel =
    scopeKind === "team_all" ? "팀 전체" : scopeKind === "team_overall" ? "팀 총괄" : effectiveScopeValue;
  const scopeReadOnly = scopeKind === "team_all";

  // 선택 팀/스코프/파트 변경 시 섹션.1 팀 보드 재조회(서버가 스코프 필터·파트별 독립 상태 반환).
  useEffect(() => {
    if (!teamMode || !effectiveTeamId) return;
    void (async () => {
      await loadTeamBoard(effectiveTeamId, scopeKind, scopePartName);
    })();
  }, [teamMode, effectiveTeamId, scopeKind, scopePartName, loadTeamBoard]);

  // 액션 성공 후 — 섹션.0(로그/상태창) + 섹션.1(선택 팀·스코프 상태) 갱신.
  const refreshAfterAction = useCallback(() => {
    void loadBoard();
    if (teamMode && effectiveTeamId) void loadTeamBoard(effectiveTeamId, scopeKind, scopePartName);
  }, [loadBoard, loadTeamBoard, teamMode, effectiveTeamId, scopeKind, scopePartName]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <AdminPageHeader
        title={`프로세스 체크 · ${hubLabel} 급`}
        description={`이번 주 [${hubLabel} 급] 프로세스 액트 체크 (조직: ${org ?? "미지정"})`}
      />

      {!org && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          조직이 지정되어야 합니다. 주소 끝에 조직 코드를 붙여 다시 열어주세요. (예: ?org=oranke)
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
      <SectionTitle>[액트 관리]</SectionTitle>
      {/* 주차 선택 — 공용 WeekSelectRow(현재 기본·미래 숨김·날짜·상태·과거 조회전용). */}
      <WeekSelectRow
        weeks={weeks}
        selectedWeekId={selectedWeekId}
        editable={editable}
        value={selValue}
        onChange={setWeekParam}
        disabled={!org}
        selectId={`process-check-week-select-${hub}`}
      />

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
              <LoadingState active variant="inline" />
            ) : logs.length === 0 ? (
              <p className="text-muted-foreground">아직 기록된 체크 로그가 없습니다.</p>
            ) : (
              logs.map((l) => (
                <p key={l.id} className="text-xs leading-relaxed">
                  <span className={cn("font-semibold", processCheckLogActionClass(l.action))}>
                    [{PROCESS_CHECK_LOG_ACTION_LABEL[l.action]}]
                  </span>{" "}
                  [{l.periodLabel}]
                  {l.teamName ? ` - ${l.teamName} 팀${l.partName ? ` · ${l.partName}` : ""} -` : ""}{" "}
                  [{l.lineGroupName}] {l.actName} - {l.actorName} 님 - {formatLogDateTime(l.createdAt)}
                </p>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* 상태창2 — 허브 전체(섹션.0). 팀 구분 허브(experience)는 "(전체 팀)" 카드 미표시
          (섹션.1 선택 팀 상태창2만 노출). info 등 비팀 허브는 그대로 유지. UI 전용 — summary 계산 무변. */}
      {!teamMode && (
        <ProcessCheckProgress
          title="상태창 2 · 이번 주 체크 진행 현황"
          summary={summary}
          lineGroups={board.lineGroups}
        />
      )}

      {/* ════ [섹션.1] 액트 체크 ════ */}
      <SectionTitle>[액트 체크]</SectionTitle>
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
                  onClick={() => {
                    setSelectedTeamId(tm.teamId);
                    setScopeValue("all"); // 팀 전환 시 팀 전체(읽기전용)로 초기화
                  }}
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
              {/* 상태창2(선택 팀 + 선택 스코프) — 좌: 상태창 / 우: 팀 & 파트 드롭다운. */}
              <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
                <div className="min-w-0 flex-1">
                  <ProcessCheckProgress
                    title={`상태창 2 · ${effectiveTeamName ?? "선택 팀"} 팀 · ${scopeLabel}`}
                    summary={teamBoard.summary}
                    lineGroups={teamBoard.lineGroups}
                  />
                </div>
                <div className="lg:w-72 lg:shrink-0">
                  <Card className="h-full">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">팀 &amp; 파트</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <label className="text-xs text-muted-foreground">체크 범위 선택</label>
                      <div className="relative">
                        <select
                          aria-label="팀 & 파트 범위"
                          value={effectiveScopeValue}
                          onChange={(e) => setScopeValue(e.target.value)}
                          className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm"
                        >
                          <option value="all">팀 전체 (읽기 전용)</option>
                          <option value="overall">팀 총괄</option>
                          {teamParts.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {scopeReadOnly
                          ? "‘팀 전체’는 팀 총괄 + 모든 파트 액트를 보여주는 읽기 전용 목록입니다."
                          : scopeKind === "team_overall"
                            ? "‘팀 총괄’ 범위 액트만 표시 — 팀 총괄 대상 크루로 체크할 수 있습니다."
                            : `이 파트 액트만 표시 — 해당 파트 소속 크루${
                                teamBoard.selectedPart ? ` ${teamBoard.selectedPart.crewCount}명` : ""
                              }로만 체크할 수 있습니다.`}
                      </p>
                      {teamParts.length === 0 && (
                        <p className="text-[11px] text-amber-600">
                          이 팀(현재 모드)에 등록된 파트가 없습니다. (팀 총괄만 사용)
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
              {/* 섹션.1 액트 목록 — 서버가 스코프 필터한 결과. 팀 전체는 읽기 전용. "팀 & 파트" 컬럼 표시. */}
              <ProcessCheckActTable
                acts={teamBoard.acts}
                loading={teamLoading}
                weekDisabled={teamWeekDisabled}
                readOnly={scopeReadOnly}
                showScopeColumn
                onOpenAct={openAct}
              />
            </>
          )}
        </div>
      ) : (
        <ProcessCheckActTable
          acts={acts}
          loading={loading}
          weekDisabled={weekDisabled}
          onOpenAct={openAct}
        />
      )}

      {dialogAct && org && (
        <ProcessCheckActDialog
          act={dialogAct}
          hub={hub}
          organization={org}
          teamId={teamMode ? effectiveTeamId : null}
          mode={mode}
          scope={teamMode ? scopeKind : null}
          partName={teamMode ? scopePartName : null}
          onClose={() => setDialogAct(null)}
          onDone={refreshAfterAction}
        />
      )}

      {/* 선별 액트 선택 모달 — [검수 링크](검수 링크 입력 UI) / [수동 입력](직접 입력 UI). */}
      {choiceAct && org && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChoiceAct(null);
          }}
        >
          <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-base font-semibold">선별 액트 체크</h2>
              <button type="button" onClick={() => setChoiceAct(null)} className="hover:opacity-70">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{choiceAct.actName}</span> — 체크 방식을 선택하세요.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setDialogAct(choiceAct);
                  setChoiceAct(null);
                }}
                className="rounded-md border border-purple-300 bg-purple-50 px-4 py-3 text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
              >
                링크 신청
                <span className="mt-0.5 block text-[11px] font-normal text-purple-600">카페 글 기반 · worker 검수</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualGrantAct(choiceAct);
                  setChoiceAct(null);
                }}
                className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm font-medium text-green-800 transition-colors hover:bg-green-100"
              >
                수동 부여
                <span className="mt-0.5 block text-[11px] font-normal text-green-600">대상 크루 · 포인트 직접 입력</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 선별 액트 수동 입력 모달 — 대상 크루 + 포인트 직접 입력(C=0 고정). */}
      {manualGrantAct && org && (
        <ProcessCheckManualGrantDialog
          act={manualGrantAct}
          hub={hub}
          organization={org}
          mode={mode}
          teamId={teamMode ? effectiveTeamId : null}
          scope={teamMode ? scopeKind : null}
          partName={teamMode ? scopePartName : null}
          onClose={() => setManualGrantAct(null)}
          onDone={refreshAfterAction}
        />
      )}
    </div>
  );
}
