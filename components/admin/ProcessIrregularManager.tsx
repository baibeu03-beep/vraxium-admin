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
import { cn } from "@/lib/utils";
import { statusTone } from "@/lib/statusBadge";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import ProcessIrregularDialog from "@/components/admin/ProcessIrregularDialog";
import ProcessIrregularManualGrantDialog from "@/components/admin/ProcessIrregularManualGrantDialog";
import ProcessIrregularReviewDetail from "@/components/admin/ProcessIrregularReviewDetail";
import { WeekSelectRow } from "@/components/admin/WeekSelectRow";
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
      const res = await fetch(appendModeQuery(url, mode));
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
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">변동 액트</h1>
          <p className="text-sm text-muted-foreground">
            정규 기준표 외 변동(비정규) 액트의 링크 신청 / 수동 부여 관리 (조직: {org ?? "미지정"})
          </p>
        </div>
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
            <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acts.map((a) => (
                    <IrregularRow key={a.id} act={a} onOpenDetail={() => setDetailAct(a)} />
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
          onClose={() => setDialog(null)}
          onDone={loadBoard}
        />
      )}

      {dialog === "review-partial" && org && (
        <ProcessIrregularDialog
          crewReaction="partial"
          organization={org}
          mode={mode}
          onClose={() => setDialog(null)}
          onDone={loadBoard}
        />
      )}

      {dialog === "manual" && org && (
        <ProcessIrregularManualGrantDialog
          organization={org}
          mode={mode}
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
      <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
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
}: {
  act: ProcessIrregularActRowDto;
  onOpenDetail: () => void;
}) {
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
      <TableCell className="max-w-[200px] truncate" title={act.reason ?? ""}>
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
    </TableRow>
  );
}
