"use client";

// /admin/processes/check/irregular — 변동(비정규) 액트 관리.
//
//   주차 드롭다운: 현재 시즌 W1~현재 주차(미래 주차 미노출). 과거 주차는 조회 전용(버튼/입력 비활성).
//     드롭다운 옆에 (YYYY-MM-DD ~ YYYY-MM-DD) + 주차 상태(공식 활동/휴식 주차) 표시.
//   우측 상단 버튼: [전원](=검수 링크·all) · [부분](→ 검수 링크 / 수동 입력 선택).
//   통계 7칸: 전체 / 링크 신청 / 수동 부여 / 체크 완료 / 체크 대기 / 전원 / 부분.
//   목록: 종류 | 액트 종류 | 액트명(비정규) | 신청자 | 소요 시간(m) | 액트 신청 사유 |
//         po A | po B | po C | 신청 시점(실제) | 검수 시점(실제) | 체크 상태.
//   검수 링크 신청은 '체크 대기' → 검수 시점 경과 시 보드에서 자동 '체크 완료'(조회 시점 파생).
//   수동 부여는 항상 즉시 '체크 완료'(체크 대기 없음).
//
// ?org 기준 데이터 분기 · ?mode(operating/test) 분리(대상자 기준). 카페=kind 파생(입력 없음).
// ⚠ 고객앱·snapshot·user_weekly_points·demoUserId 무접촉(관리자 전용).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingState } from "@/components/ui/loading-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";
import { statusTone } from "@/lib/statusBadge";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import ProcessIrregularDialog from "@/components/admin/ProcessIrregularDialog";
import ProcessIrregularManualGrantDialog from "@/components/admin/ProcessIrregularManualGrantDialog";
import ProcessIrregularReviewDetail from "@/components/admin/ProcessIrregularReviewDetail";
import { WeekSelectRow } from "@/components/admin/WeekSelectRow";
import { ActionControl } from "@/components/admin/ActionControl";
import { ACTION_CONTROL_REGISTRY } from "@/lib/actionControl/registry";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import {
  IRREGULAR_STATUS_LABEL,
  emptyProcessIrregularBoard,
  formatCheckDateTimeKo,
  type IrregularCrewReaction,
  type ProcessIrregularActRowDto,
  type ProcessIrregularBoardDto,
} from "@/lib/adminProcessIrregularTypes";

// 다이얼로그 모드 — null | 전원(검수·all) | 부분 선택 | 부분 검수(partial) | 수동 부여.
type DialogMode = "review-all" | "partial-choice" | "review-partial" | "manual";

// 요약 1칸 — 칸막이(divide-x) 형태의 간단 표기.
function SummaryCell({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-2 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-lg font-semibold tabular-nums", accent)}>{value}</span>
    </div>
  );
}

export default function ProcessIrregularManager() {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  const mode = readScopeMode(searchParams);

  const [board, setBoard] = useState<ProcessIrregularBoardDto>(() =>
    emptyProcessIrregularBoard(org ?? ""),
  );
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  // 사용자가 선택한 주차(weeks.id). null = 현재 주차(서버 기본).
  const [weekParam, setWeekParam] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [detailAct, setDetailAct] = useState<ProcessIrregularActRowDto | null>(null);
  const reqRef = useRef(0);

  const loadBoard = useCallback(async () => {
    if (!org) {
      setLoading(false);
      return;
    }
    const myReq = ++reqRef.current;
    setLoading(true);
    try {
      let url = `/api/admin/processes/check/irregular?org=${encodeURIComponent(org)}`;
      if (weekParam) url += `&week=${encodeURIComponent(weekParam)}`;
      const res = await fetch(appendModeQuery(url, mode), { cache: "no-store" });
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
  }, [org, mode, weekParam]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  // 즉시 검수(행 단위) — '체크 대기' 링크 신청 행을 검수 시점 전이라도 지금 바로 검수.
  const confirm = useConfirm();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewBanner, setReviewBanner] = useState<{ kind: "success" | "info"; message: string } | null>(null);
  const handleImmediateReview = useCallback(
    async (act: ProcessIrregularActRowDto) => {
      if (reviewingId) return;
      const ok = await confirm({
        title: "즉시 검수",
        description: "이 항목을 지금 바로 검수하시겠습니까?",
        confirmLabel: "즉시 검수",
      });
      if (!ok) return;
      setReviewingId(act.id);
      setReviewBanner(null);
      try {
        const res = await fetch("/api/admin/qa/run-now/process-check-row", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusId: act.id, source: "irregular" }),
        });
        const json = await res.json().catch(() => ({}));
        // 즉시 검수는 크롤 결과와 무관하게 항상 '체크 완료' — code 는 크롤 결과(메시지)만 구분.
        if (!res.ok || !json?.success || json?.data?.status !== "completed") {
          setReviewBanner({ kind: "info", message: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
        } else {
          const code: string = json?.data?.code ?? "not_found";
          const COPY: Record<string, { kind: "success" | "info"; message: string }> = {
            confirmed: { kind: "success", message: "인증 내용을 확인했습니다. 체크 완료로 처리했습니다." },
            no_match: { kind: "info", message: "인증 댓글은 있었지만 대상자를 찾지 못했습니다. 체크 완료로 처리했습니다." },
            not_found: { kind: "info", message: "인증 내용을 찾지 못했습니다. 체크 완료로 처리했습니다." },
          };
          setReviewBanner(COPY[code] ?? COPY.not_found);
        }
        await loadBoard();
      } catch {
        setReviewBanner({ kind: "info", message: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      } finally {
        setReviewingId(null);
      }
    },
    [confirm, reviewingId, loadBoard],
  );

  // ↩ 실행 취소(행 단위) — 완료된 액트를 '실행 전' 상태로 복원(다시 검수/부여 가능).
  //   링크 신청 → 체크 대기(행 유지·재검수) · 수동 부여 → 행 삭제. 공통 포인트 회수 + snapshot 재계산.
  //   확인 모달은 ActionControl 이 담당하므로 여기서는 별도 confirm 없이 요청만 보낸다. org/mode 무관.
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const handleRollback = useCallback(
    async (act: ProcessIrregularActRowDto) => {
      if (!org || rollingBackId) return;
      setRollingBackId(act.id);
      setReviewBanner(null);
      try {
        const res = await fetch("/api/admin/processes/check/irregular/rollback", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: act.id, organization: org, ...(mode === "test" ? { mode: "test" } : {}) }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.success) {
          setReviewBanner({ kind: "info", message: json?.error ?? "실행 취소를 처리하지 못했습니다." });
        } else {
          setReviewBanner({
            kind: "success",
            message:
              act.kind === "manual_grant"
                ? "수동 부여를 실행 전(부여 없음) 상태로 되돌렸습니다(항목 삭제·포인트 회수·카드 재계산)."
                : "검수를 취소하고 ‘체크 대기(검수 전)’ 상태로 되돌렸습니다(포인트 회수·카드 재계산·재검수 가능).",
          });
        }
        await loadBoard();
      } catch {
        setReviewBanner({ kind: "info", message: "실행 취소를 처리하지 못했습니다." });
      } finally {
        setRollingBackId(null);
      }
    },
    [org, mode, rollingBackId, loadBoard],
  );

  const { weeks, selectedWeekId, editable, summary, acts } = board;

  // 현재 select 표시값 — 사용자가 막 고른 값(weekParam) 우선, 없으면 서버 선택값.
  const selValue = weekParam ?? selectedWeekId ?? "";

  const summaryCells = useMemo(
    () => [
      { label: "전체 갯수", value: summary.total },
      { label: "링크 신청", value: summary.reviewRequest, accent: "text-purple-700" },
      { label: "수동 부여", value: summary.manualGrant, accent: "text-green-700" },
      { label: "체크 완료", value: summary.completed, accent: "text-green-700" },
      { label: "체크 대기", value: summary.pending, accent: "text-amber-700" },
      { label: "전원", value: summary.all, accent: "text-blue-700" },
      { label: "부분", value: summary.partial, accent: "text-orange-700" },
    ],
    [summary],
  );

  const canAct = Boolean(org) && editable;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold">변동 액트</h1>
        <AdminHelp />
        {/* 우측 상단 버튼 — [전원] [부분]. 과거 주차(조회 전용)에서는 비활성. */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!canAct}
            onClick={() => setDialog("review-all")}
            className="rounded-md border border-blue-300 bg-blue-50 px-5 py-2 text-sm font-medium text-blue-800 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            전원
          </button>
          <button
            type="button"
            disabled={!canAct}
            onClick={() => setDialog("partial-choice")}
            className="rounded-md border border-orange-300 bg-orange-50 px-5 py-2 text-sm font-medium text-orange-800 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            부분
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

      {/* 즉시 검수 결과 배너 — 검수 완료 / 카페에서 인증 내용을 찾지 못했습니다. */}
      {reviewBanner && (
        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            reviewBanner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800",
          )}
        >
          <span>{reviewBanner.message}</span>
          <button type="button" onClick={() => setReviewBanner(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 주차 선택 — 공용 WeekSelectRow(프로세스 체크와 동일 SoT). */}
      <WeekSelectRow
        weeks={weeks}
        selectedWeekId={selectedWeekId}
        editable={editable}
        value={selValue}
        onChange={setWeekParam}
        disabled={!org}
        selectId="irregular-week-select"
      />

      {/* 통계 7칸 — 1행 7열 칸막이 */}
      <div className="flex divide-x rounded-md border bg-card">
        {summaryCells.map((c) => (
          <SummaryCell key={c.label} label={c.label} value={c.value} accent={c.accent} />
        ))}
      </div>

      {/* 액트 목록 */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <LoadingState active />
          ) : acts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">변동 액트가 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>종류</TableHead>
                    <TableHead>액트 종류</TableHead>
                    <TableHead>액트명(비정규)</TableHead>
                    <TableHead>신청자</TableHead>
                    <TableHead>소요 시간(m)</TableHead>
                    <TableHead>액트 신청 사유</TableHead>
                    <TableHead>po A</TableHead>
                    <TableHead>po B</TableHead>
                    <TableHead>po C</TableHead>
                    <TableHead>신청 시점(실제)</TableHead>
                    <TableHead>검수 시점(실제)</TableHead>
                    <TableHead>체크 상태</TableHead>
                    <TableHead className="text-center">즉시 검수</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acts.map((a) => (
                    <IrregularRow
                      key={a.id}
                      act={a}
                      onOpenDetail={() => setDetailAct(a)}
                      onImmediateReview={() => handleImmediateReview(a)}
                      reviewing={reviewingId === a.id}
                      onRollback={() => handleRollback(a)}
                      rollbackMode={mode === "test" ? "test" : "operating"}
                      rollingBack={rollingBackId === a.id}
                      editable={editable}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 부분 선택 팝업 — 검수 링크 / 수동 입력 */}
      {dialog === "partial-choice" && (
        <PartialChoiceDialog
          onClose={() => setDialog(null)}
          onReview={() => setDialog("review-partial")}
          onManual={() => setDialog("manual")}
        />
      )}

      {dialog === "review-all" && org && (
        <ProcessIrregularDialog
          crewReaction="all"
          organization={org}
          mode={mode}
          weekId={selectedWeekId}
          onClose={() => setDialog(null)}
          onDone={loadBoard}
        />
      )}

      {dialog === "review-partial" && org && (
        <ProcessIrregularDialog
          crewReaction="partial"
          organization={org}
          mode={mode}
          weekId={selectedWeekId}
          onClose={() => setDialog(null)}
          onDone={loadBoard}
        />
      )}

      {dialog === "manual" && org && (
        <ProcessIrregularManualGrantDialog
          organization={org}
          mode={mode}
          weekId={selectedWeekId}
          onClose={() => setDialog(null)}
          onDone={loadBoard}
        />
      )}

      {detailAct && org && (
        <ProcessIrregularReviewDetail
          act={detailAct}
          organization={org}
          mode={mode}
          editable={editable}
          onClose={() => setDetailAct(null)}
          onDone={loadBoard}
        />
      )}
    </div>
  );
}

// 부분 버튼 클릭 시 — 검수 링크 / 수동 입력 선택 팝업.
function PartialChoiceDialog({
  onClose,
  onReview,
  onManual,
}: {
  onClose: () => void;
  onReview: () => void;
  onManual: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-w-sm rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            부분 액트 · <span className="text-orange-700">방식 선택</span>
          </h2>
          <button type="button" onClick={onClose} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">부분 액트를 어떤 방식으로 등록할까요?</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onReview}
            className="rounded-md border border-purple-300 bg-purple-50 px-4 py-3 text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
          >
            링크 신청
          </button>
          <button
            type="button"
            onClick={onManual}
            className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm font-medium text-green-800 transition-colors hover:bg-green-100"
          >
            수동 부여
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}

function IrregularRow({
  act,
  onOpenDetail,
  onImmediateReview,
  reviewing,
  onRollback,
  rollbackMode,
  rollingBack,
  editable,
}: {
  act: ProcessIrregularActRowDto;
  onOpenDetail: () => void;
  onImmediateReview: () => void;
  reviewing: boolean;
  onRollback: () => void;
  rollbackMode: "operating" | "test";
  rollingBack: boolean;
  editable: boolean;
}) {
  // 즉시 검수 = '체크 대기'(pending) 링크 신청(review_request) + 검수 링크가 있는 행만.
  const canReviewNow =
    act.kind === "review_request" && act.status === "pending" && Boolean(act.reviewLink);
  // ↩ 실행 취소 = 완료된 액트를 '실행 전' 상태로. 단, 예약 검수 시각 경과로 '표시상 자동 완료'된
  //   링크 신청(DB 는 pending·워커 미실행·회수 대상 없음)은 되돌릴 실행이 없어 비활성.
  const canRollback = editable && act.status === "completed" && !act.autoCompleted;
  const rollbackBlocked = editable && act.status === "completed" && act.autoCompleted;
  const rollbackConfirm =
    act.kind === "manual_grant"
      ? "이 수동 부여를 실행 전(부여 없음) 상태로 되돌립니다.\n\n항목이 삭제되고 적립된 포인트가 회수됩니다(관련 카드 재계산).\n\n계속하시겠습니까?"
      : "이 검수를 취소하고 ‘체크 대기(검수 전)’ 상태로 되돌립니다.\n\n적립된 포인트가 회수되고, 다시 검수할 수 있습니다(행은 유지).\n\n계속하시겠습니까?";
  const crewTone: Record<IrregularCrewReaction, string> = {
    all: "border-blue-300 bg-blue-50 text-blue-700",
    partial: "border-orange-300 bg-orange-50 text-orange-700",
  };
  return (
    <TableRow>
      <TableCell>
        <StatusBadge label={act.kindLabel} size="sm" />
      </TableCell>
      <TableCell>
        <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", crewTone[act.crewReaction])}>
          {act.crewReactionLabel}
        </span>
      </TableCell>
      <TableCell className="font-medium">{act.actName}</TableCell>
      <TableCell className="whitespace-nowrap">{act.applicantAdminName}</TableCell>
      <TableCell className="tabular-nums">{act.durationMinutes ?? "—"}</TableCell>
      <TableCell className="max-w-[280px] truncate" title={act.reason ?? ""}>
        {act.reason || "—"}
      </TableCell>
      <TableCell className="tabular-nums">{act.pointA}</TableCell>
      <TableCell className="tabular-nums">{act.pointB}</TableCell>
      <TableCell className="tabular-nums">{act.pointC}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {act.createdAt ? formatCheckDateTimeKo(act.createdAt) : "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {act.scheduledCheckAt ? formatCheckDateTimeKo(act.scheduledCheckAt) : "—"}
      </TableCell>
      <TableCell className="text-center">
        {/* 상태 배지 클릭 → 상세 모달(체크 취소/삭제·검수 링크는 모달 내). */}
        <StatusBadge
          tone={statusTone(IRREGULAR_STATUS_LABEL[act.status])}
          size="sm"
          onClick={onOpenDetail}
          title="클릭하여 상세 보기"
          label={IRREGULAR_STATUS_LABEL[act.status]}
        />
      </TableCell>
      {/* '즉시 검수' 전용 컬럼 — 대기(pending)=⚡즉시 검수 / 완료(completed)=↩실행 취소(실행 전 복원). */}
      <TableCell className="text-center">
        {canReviewNow ? (
          <button
            type="button"
            onClick={onImmediateReview}
            disabled={reviewing}
            className="rounded-md border border-purple-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50"
            title="검수 시점 전이라도 지금 바로 검수합니다."
          >
            {reviewing ? "검수 중…" : "즉시 검수"}
          </button>
        ) : canRollback || rollbackBlocked ? (
          <div className="inline-flex justify-center" data-ir-rollback={act.id}>
            <ActionControl
              hideInstant
              size="xs"
              rollbackClass={ACTION_CONTROL_REGISTRY.processIrregularGrant.rollback.class}
              mode={rollbackMode}
              onRollback={onRollback}
              rollbackBusy={rollingBack}
              rollbackDisabled={rollbackBlocked}
              rollbackDisabledReason={
                rollbackBlocked
                  ? "예약 검수 시각이 지나 자동 완료된 건은 되돌릴 수 없습니다(워커 검수 후 취소 가능)."
                  : undefined
              }
              rollbackConfirmDescription={rollbackConfirm}
            />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
