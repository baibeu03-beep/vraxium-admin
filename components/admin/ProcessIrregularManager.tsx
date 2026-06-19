"use client";

// /admin/processes/check/irregular — 변동 액트 관리(현재/마지막 활동 주차 고정).
//
//   우측 상단: [수동 입력] [검수 링크] (1행 2열).
//   요약 5칸(1행 5열·칸막이): 전체 / 검수 링크 / 수동 입력 / 체크 완료 / 체크 대기.
//   목록: 종류·카페·액트명·신청자·소요시간·사유·포인트 A/B/C·크루반응(드롭다운)·검수링크·검수시점 + 관리.
//
// ?org 기준 데이터 분기 · ?mode(operating/test) 분리(대상자 기준). 카페=kind 파생(입력 없음).
// ⚠ 고객앱·snapshot·user_weekly_points·demoUserId 무접촉(관리자 전용).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { statusTone } from "@/lib/statusBadge";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import ProcessIrregularDialog from "@/components/admin/ProcessIrregularDialog";
import ProcessIrregularManualGrantDialog from "@/components/admin/ProcessIrregularManualGrantDialog";
import ProcessIrregularReviewDetail from "@/components/admin/ProcessIrregularReviewDetail";
import {
  IRREGULAR_CREW_REACTIONS,
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_STATUS_LABEL,
  emptyProcessIrregularBoard,
  formatCheckDateTimeKo,
  type IrregularCrewReaction,
  type IrregularKind,
  type ProcessIrregularActRowDto,
  type ProcessIrregularBoardDto,
} from "@/lib/adminProcessIrregularTypes";

// 요약 1칸 — 칸막이(divide-x) 형태의 간단 표기.
function SummaryCell({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-lg font-semibold tabular-nums", accent)}>{value}</span>
    </div>
  );
}

export default function ProcessIrregularManager() {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  const mode = readScopeMode(searchParams);
  const confirm = useConfirm();

  const [board, setBoard] = useState<ProcessIrregularBoardDto>(() =>
    emptyProcessIrregularBoard(org ?? ""),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<IrregularKind | null>(null);
  const [detailAct, setDetailAct] = useState<ProcessIrregularActRowDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reqRef = useRef(0);

  const loadBoard = useCallback(async () => {
    if (!org) {
      setLoading(false);
      return;
    }
    const myReq = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/processes/check/irregular?org=${encodeURIComponent(org)}`, mode),
      );
      const json = await res.json().catch(() => ({}));
      if (myReq !== reqRef.current) return;
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setBoard(json.data as ProcessIrregularBoardDto);
      setError(null);
    } catch (err) {
      if (myReq !== reqRef.current) return;
      setBoard(emptyProcessIrregularBoard(org));
      setError(err instanceof Error ? err.message : "조회에 실패했습니다");
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, [org, mode]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const { week, summary, acts } = board;
  const periodLabel = week?.periodLabel ?? "주차 정보 없음";
  const weekDisabled = !week?.weekId;

  // 인라인 PATCH(액트 종류 변경 / 체크 완료) + DELETE.
  const patchRow = useCallback(
    async (id: string, payload: Record<string, unknown>) => {
      if (!org) return;
      setBusyId(id);
      try {
        const res = await fetch("/api/admin/processes/check/irregular", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, organization: org, ...(mode === "test" ? { mode: "test" } : {}), ...payload }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        await loadBoard();
      } catch (err) {
        setError(err instanceof Error ? err.message : "처리에 실패했습니다");
      } finally {
        setBusyId(null);
      }
    },
    [org, mode, loadBoard],
  );

  const summaryCells = useMemo(
    () => [
      { label: "전체 갯수", value: summary.total },
      { label: "검수 링크", value: summary.reviewRequest, accent: "text-purple-700" },
      { label: "수동 입력", value: summary.manualGrant, accent: "text-green-700" },
      { label: "체크 완료", value: summary.completed, accent: "text-green-700" },
      { label: "체크 대기", value: summary.pending, accent: "text-amber-700" },
    ],
    [summary],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">변동 액트</h1>
          <p className="text-sm text-muted-foreground">
            정규 기준표 외 변동 액트의 검수 링크 / 수동 입력 관리 (조직: {org ?? "미지정"})
          </p>
        </div>
        {/* 우측 상단 버튼 — 1행 2열 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!org || weekDisabled}
            onClick={() => setDialogKind("manual_grant")}
            className="rounded-md border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-800 transition-colors hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            수동 입력
          </button>
          <button
            type="button"
            disabled={!org || weekDisabled}
            onClick={() => setDialogKind("review_request")}
            className="rounded-md border border-purple-300 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            검수 링크
          </button>
        </div>
      </div>

      {!org && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          조직(?org)이 지정되어야 합니다. 예: <code>/admin/processes/check/irregular?org=oranke</code>
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

      {/* 주차명 — 읽기 전용(운영=현재 / 테스트=마지막 활동 주차). */}
      <div className="max-w-xs space-y-1">
        <label className="text-xs text-muted-foreground">주차명 (변경 불가)</label>
        <div
          aria-disabled="true"
          aria-label="주차명"
          className="flex cursor-not-allowed items-center justify-between rounded-md border border-input bg-muted/50 px-3 py-2 text-sm"
        >
          <span className={cn(weekDisabled && "text-muted-foreground")}>{periodLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </div>

      {/* 요약 5칸 — 1행 5열 칸막이 */}
      <div className="flex divide-x rounded-md border bg-card">
        {summaryCells.map((c) => (
          <SummaryCell key={c.label} label={c.label} value={c.value} accent={c.accent} />
        ))}
      </div>

      {/* 액트 목록 */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
          ) : acts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">변동 액트가 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>종류</TableHead>
                    <TableHead>카페</TableHead>
                    <TableHead>액트명(변동)</TableHead>
                    <TableHead>신청자</TableHead>
                    <TableHead>소요(m)</TableHead>
                    <TableHead>액트 신청 사유</TableHead>
                    <TableHead>Po.A</TableHead>
                    <TableHead>Po.B</TableHead>
                    <TableHead>Po.C</TableHead>
                    <TableHead>액트 종류</TableHead>
                    <TableHead>검수 링크</TableHead>
                    <TableHead>검수 시점</TableHead>
                    <TableHead>관리</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acts.map((a) => (
                    <IrregularRow
                      key={a.id}
                      act={a}
                      busy={busyId === a.id}
                      onCrewReaction={(cr) =>
                        void (async () => {
                          // 액트 종류 변경 = 즉시 저장 — 한 번 더 확인.
                          const ok = await confirm(CONFIRM.save);
                          if (!ok) return;
                          await patchRow(a.id, { action: "set_crew_reaction", crew_reaction: cr });
                        })()
                      }
                      onOpenDetail={() => setDetailAct(a)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialogKind === "review_request" && org && (
        <ProcessIrregularDialog
          kind="review_request"
          organization={org}
          mode={mode}
          onClose={() => setDialogKind(null)}
          onDone={loadBoard}
        />
      )}

      {dialogKind === "manual_grant" && org && (
        <ProcessIrregularManualGrantDialog
          organization={org}
          mode={mode}
          onClose={() => setDialogKind(null)}
          onDone={loadBoard}
        />
      )}

      {detailAct && org && (
        <ProcessIrregularReviewDetail
          act={detailAct}
          organization={org}
          mode={mode}
          onClose={() => setDetailAct(null)}
          onDone={loadBoard}
        />
      )}
    </div>
  );
}

function IrregularRow({
  act,
  busy,
  onCrewReaction,
  onOpenDetail,
}: {
  act: ProcessIrregularActRowDto;
  busy: boolean;
  onCrewReaction: (cr: IrregularCrewReaction) => void;
  onOpenDetail: () => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <StatusBadge label={act.kindLabel} size="sm" />
      </TableCell>
      <TableCell className="text-muted-foreground">{act.cafeLabel}</TableCell>
      <TableCell className="font-medium">{act.actName}</TableCell>
      <TableCell className="whitespace-nowrap">{act.applicantAdminName}</TableCell>
      <TableCell className="tabular-nums">{act.durationMinutes ?? "—"}</TableCell>
      <TableCell className="max-w-[200px] truncate" title={act.reason ?? ""}>
        {act.reason || "—"}
      </TableCell>
      <TableCell className="tabular-nums">{act.pointA}</TableCell>
      <TableCell className="tabular-nums">{act.pointB}</TableCell>
      <TableCell className="tabular-nums">{act.pointC}</TableCell>
      <TableCell>
        <select
          aria-label="액트 종류"
          value={act.crewReaction}
          disabled={busy}
          onChange={(e) => onCrewReaction(e.target.value as IrregularCrewReaction)}
          className="h-8 rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-60"
        >
          {IRREGULAR_CREW_REACTIONS.map((c) => (
            // 수동 입력는 '전원' 불가(부분 고정) — 해당 옵션 비활성.
            <option key={c} value={c} disabled={c === "all" && act.kind === "manual_grant"}>
              {IRREGULAR_CREW_REACTION_LABEL[c]}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="max-w-[160px]">
        {act.reviewLink ? (
          <a
            href={act.reviewLink}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-blue-600 underline"
            title={act.reviewLink}
          >
            {act.reviewLink}
          </a>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {act.scheduledCheckAt ? formatCheckDateTimeKo(act.scheduledCheckAt) : "—"}
      </TableCell>
      <TableCell className="text-center">
        {/* 상태 배지가 상세 보기 역할까지 통합 — 클릭 시 상세 모달(체크 취소/삭제는 모달 내). */}
        <StatusBadge
          tone={statusTone(IRREGULAR_STATUS_LABEL[act.status])}
          size="sm"
          disabled={busy}
          onClick={onOpenDetail}
          title="클릭하여 상세 보기"
          label={
            <>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {IRREGULAR_STATUS_LABEL[act.status]}
            </>
          }
        />
      </TableCell>
    </TableRow>
  );
}
