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
import { ChevronDown, ChevronUp, ChevronsUpDown, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
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
import { pointColorClass } from "@/components/ui/point-value";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import ExecutionTimeCell from "@/components/admin/ExecutionTimeCell";
import { useStickyColumns, type StickyColProps } from "@/components/ui/sticky-columns";
import { statusTone } from "@/lib/statusBadge";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import ProcessIrregularDialog from "@/components/admin/ProcessIrregularDialog";
import ProcessIrregularManualGrantDialog from "@/components/admin/ProcessIrregularManualGrantDialog";
import ProcessIrregularReviewDetail from "@/components/admin/ProcessIrregularReviewDetail";
import { WeekSelectRow } from "@/components/admin/WeekSelectRow";
import { ActionControl, INSTANT_REVIEW_BUTTON_CLASS } from "@/components/admin/ActionControl";
import { ACTION_CONTROL_REGISTRY } from "@/lib/actionControl/registry";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import {
  IRREGULAR_STATUS_LABEL,
  PROCESS_IRREGULAR_HELP_KEYS,
  emptyProcessIrregularBoard,
  formatCheckDateTimeKo,
  type IrregularCrewReaction,
  type IrregularStatus,
  type ProcessIrregularActRowDto,
  type ProcessIrregularBoardDto,
} from "@/lib/adminProcessIrregularTypes";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

// 다이얼로그 모드 — null | 전원(검수·all) | 부분 선택 | 부분 검수(partial) | 수동 부여.
type DialogMode = "review-all" | "partial-choice" | "review-partial" | "manual";

// ── 정렬(3단계) 메타(순수) — 컬럼 key ↔ 값 추출 + 타입. 표시 문자열이 아니라 원본 필드를 기준한다. ──
type IrregularSortKey =
  | "kind"
  | "crewReaction"
  | "actName"
  | "applicant"
  | "duration"
  | "reason"
  | "pointA"
  | "pointB"
  | "pointC"
  | "createdAt"
  | "completedAt"
  | "status";
type IrregularSortDir = "asc" | "desc";
type IrregularSortType = "string" | "number" | "date" | "status";

// 상태 업무 순서 — 체크 대기(pending) → 체크 완료(completed).
const IRREGULAR_STATUS_ORDER: Record<IrregularStatus, number> = { pending: 0, completed: 1 };

const IRREGULAR_SORT_META: Record<
  IrregularSortKey,
  { type: IrregularSortType; get: (a: ProcessIrregularActRowDto) => string | number | null }
> = {
  kind: { type: "string", get: (a) => a.kindLabel },
  crewReaction: { type: "string", get: (a) => a.crewReactionLabel },
  actName: { type: "string", get: (a) => a.actName },
  applicant: { type: "string", get: (a) => a.applicantAdminName },
  duration: { type: "number", get: (a) => a.durationMinutes },
  reason: { type: "string", get: (a) => a.reason },
  pointA: { type: "number", get: (a) => a.pointA },
  pointB: { type: "number", get: (a) => a.pointB },
  pointC: { type: "number", get: (a) => a.pointC },
  createdAt: { type: "date", get: (a) => a.createdAt },
  // 검수 시점(실제) = 실제 검수가 완료된 서버 시각(completed_at). 예정값(scheduled_check_at) 아님.
  completedAt: { type: "date", get: (a) => a.completedAt },
  status: { type: "status", get: (a) => a.status },
};

// 빈값 판정 — null/undefined/""/공백/"-" · 숫자 NaN · 날짜 파싱 불가. (숫자 0 은 유효값)
function irregularValueIsEmpty(type: IrregularSortType, raw: string | number | null): boolean {
  if (raw === null || raw === undefined) return true;
  if (type === "number") return Number.isNaN(raw as number);
  if (type === "date") return Number.isNaN(Date.parse(String(raw)));
  const s = String(raw).trim();
  return s === "" || s === "-";
}

// 두 행 비교 — 빈값은 방향 무관 항상 마지막. 그 외는 타입별 비교 후 방향 반영.
function compareIrregularRows(
  key: IrregularSortKey,
  dir: IrregularSortDir,
  x: ProcessIrregularActRowDto,
  y: ProcessIrregularActRowDto,
): number {
  const meta = IRREGULAR_SORT_META[key];
  const rawA = meta.get(x);
  const rawB = meta.get(y);
  const emptyA = irregularValueIsEmpty(meta.type, rawA);
  const emptyB = irregularValueIsEmpty(meta.type, rawB);
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1; // 빈값 → 항상 마지막
  if (emptyB) return -1;
  let c = 0;
  if (meta.type === "number") c = (rawA as number) - (rawB as number);
  else if (meta.type === "date") c = Date.parse(String(rawA)) - Date.parse(String(rawB));
  else if (meta.type === "status")
    c = IRREGULAR_STATUS_ORDER[rawA as IrregularStatus] - IRREGULAR_STATUS_ORDER[rawB as IrregularStatus];
  else c = String(rawA).localeCompare(String(rawB), "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

function IrregularSortIcon({ dir }: { dir: IrregularSortDir | null }) {
  if (dir === "asc") return <ChevronUp className="h-3.5 w-3.5" aria-hidden />;
  if (dir === "desc") return <ChevronDown className="h-3.5 w-3.5" aria-hidden />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden />;
}

// 테이블 헤더 셀 — 컬럼명(정렬 버튼)·정렬 아이콘·돋보기 도움말을 분리. 돋보기는 정렬 버튼 바깥.
//   sortKey/onSort 전달 시 정렬 가능(버튼). 미전달이면 정적 라벨(액션 컬럼). 헤더 높이/폭 증가 없이 인라인.
function HeadCell({
  label,
  helpKey,
  className,
  sortKey,
  activeDir,
  onSort,
  sticky,
}: {
  label: string;
  helpKey: string;
  className?: string;
  sticky?: StickyColProps;
  sortKey?: IrregularSortKey;
  activeDir?: IrregularSortDir | null;
  onSort?: (key: IrregularSortKey) => void;
}) {
  const canSort = Boolean(sortKey && onSort);
  return (
    <TableHead
      className={cn(className, sticky?.className)}
      data-sticky-col={sticky?.["data-sticky-col"]}
    >
      <span className="inline-flex items-center justify-center gap-1">
        {canSort ? (
          <button
            type="button"
            onClick={() => onSort!(sortKey!)}
            aria-label={`${label} 정렬`}
            className="inline-flex cursor-pointer items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-500/40"
          >
            <span>{label}</span>
            <IrregularSortIcon dir={activeDir ?? null} />
          </button>
        ) : (
          <span>{label}</span>
        )}
        <AdminHelpIconButton helpKey={helpKey} title={label} />
      </span>
    </TableHead>
  );
}

// 요약 1칸 — 칸막이(divide-x) 형태의 간단 표기. helpKey 전달 시 라벨 옆 돋보기(값에는 미적용).
function SummaryCell({
  label,
  value,
  accent,
  helpKey,
}: {
  label: string;
  value: number;
  accent?: string;
  helpKey?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-2 py-2">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} />}
      </span>
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
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, "조회에 실패했습니다");
      setBoard(json.data as ProcessIrregularBoardDto);
      setError(null);
    } catch (err) {
      if (myReq !== reqRef.current) return;
      console.error("[process-irregular] load failed", err);
      setBoard(emptyProcessIrregularBoard(org));
      setError(getApiErrorMessage(err, "조회에 실패했습니다"));
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, [org, mode, weekParam]);

  useEffect(() => {
    void (async () => {
      await loadBoard();
    })();
  }, [loadBoard]);

  // 즉시 검수(행 단위) — '체크 대기' 링크 신청 행을 검수 시점 전이라도 지금 바로 검수.
  const confirm = useConfirm();
  // 진행 중/완료/실패 안내는 모두 화면 하단 고정 토스트로(문서 흐름 인라인 배너 대신).
  const { toast, loading: toastLoading, dismiss: toastDismiss } = useToast();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  // 즉시 검수/실행 취소 중 하나라도 진행 중이면 관련 버튼을 함께 비활성화(상충 요청 차단).
  const anyActionBusy = reviewingId !== null || rollingBackId !== null;
  const handleImmediateReview = useCallback(
    async (act: ProcessIrregularActRowDto) => {
      if (anyActionBusy) return; // 중복/상충 요청 차단
      const ok = await confirm({
        title: "즉시 검수",
        description: "이 항목을 지금 바로 검수하시겠습니까?",
        confirmLabel: "즉시 검수",
      });
      if (!ok) return;
      setReviewingId(act.id);
      // 클릭 직후 하단 고정 로딩 토스트 — HTTP 응답 완료(보드 갱신 포함)까지 유지.
      const loadingId = toastLoading("주차 검수를 진행하고 있습니다. 완료될 때까지 잠시 기다려주세요.");
      try {
        const res = await fetch("/api/admin/qa/run-now/process-check-row", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusId: act.id, source: "irregular" }),
        });
        const json = await res.json().catch(() => ({}));
        await loadBoard();
        // 즉시 검수는 크롤 결과(confirmed/no_match/not_found)와 무관하게 항상 '체크 완료' 처리된다.
        //   → 성공 토스트에는 내부 크롤 판단 사유를 노출하지 않고 결과(완료)만 간결히 알린다.
        //   status!=='completed' 만 실제 이상 상황으로 오류 안내.
        if (!res.ok || !json?.success || json?.data?.status !== "completed") {
          console.warn("[process-irregular][즉시 검수] 완료되지 않음", {
            statusId: act.id,
            status: json?.data?.status ?? null,
            code: json?.data?.code ?? null,
            error: json?.error ?? null,
          });
          toast("info", "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        } else {
          // 내부 크롤 판단 사유(code)는 UI 가 아니라 콘솔 로그로만 남긴다.
          console.info("[process-irregular][즉시 검수] 완료", {
            statusId: act.id,
            code: json?.data?.code ?? null,
          });
          toast("success", "즉시 검수가 완료되었습니다.");
        }
      } catch {
        toast("info", "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      } finally {
        toastDismiss(loadingId);
        setReviewingId(null);
      }
    },
    [confirm, anyActionBusy, loadBoard, toast, toastLoading, toastDismiss],
  );

  // ↩ 실행 취소(행 단위) — 완료된 액트를 '실행 전' 상태로 복원(다시 검수/부여 가능).
  //   링크 신청 → 체크 대기(행 유지·재검수) · 수동 부여 → 행 삭제. 공통 포인트 회수 + snapshot 재계산.
  //   확인 모달은 ActionControl 이 담당하므로 여기서는 별도 confirm 없이 요청만 보낸다. org/mode 무관.
  const handleRollback = useCallback(
    async (act: ProcessIrregularActRowDto) => {
      if (!org || anyActionBusy) return; // 중복/상충 요청 차단
      setRollingBackId(act.id);
      // 클릭 직후 하단 고정 로딩 토스트 — 항목 삭제/포인트 회수·카드 재계산까지 응답 완료 전 유지.
      const loadingId = toastLoading("검수 결과를 되돌리고 있습니다. 완료될 때까지 잠시 기다려주세요.");
      try {
        const res = await fetch("/api/admin/processes/check/irregular/rollback", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: act.id, organization: org, ...(mode === "test" ? { mode: "test" } : {}) }),
        });
        const json = await res.json().catch(() => ({}));
        await loadBoard();
        if (!res.ok || !json?.success) {
          console.warn("[process] revert failed", json?.error);
          toast("info", "실행 취소를 처리하지 못했습니다.");
        } else {
          // 내부 처리 과정(항목 삭제·포인트 회수·카드 재계산·상태 복원 등)은 콘솔 로그로만 남기고,
          //   관리자 UI 에는 결과만 간결히 안내한다.
          console.info("[process-irregular][실행 취소] 완료", { statusId: act.id, kind: act.kind });
          toast("success", "실행 취소가 완료되었습니다.");
        }
      } catch {
        toast("info", "실행 취소를 처리하지 못했습니다.");
      } finally {
        toastDismiss(loadingId);
        setRollingBackId(null);
      }
    },
    [org, mode, anyActionBusy, loadBoard, toast, toastLoading, toastDismiss],
  );

  const { weeks, selectedWeekId, editable, summary, acts } = board;

  // 현재 select 표시값 — 사용자가 막 고른 값(weekParam) 우선, 없으면 서버 선택값.
  const selValue = weekParam ?? selectedWeekId ?? "";

  // 왼쪽 2열 고정(종류·액트 종류) — 공통 sticky 계약.
  const sticky = useStickyColumns({ headerSticky: true });

  // 3단계 정렬 상태 — null = 서버 기본 순서(최신순/생성 역순). 원본 acts 는 mutate 하지 않는다.
  const [sort, setSort] = useState<{ key: IrregularSortKey; dir: IrregularSortDir } | null>(null);
  const cycleSort = useCallback((key: IrregularSortKey) => {
    // asc → desc → 기본(null·서버 순서 복귀).
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  // 정렬 헤더에 넘길 props 헬퍼(중복 축소).
  const headSort = useCallback(
    (key: IrregularSortKey) => ({
      sortKey: key,
      activeDir: sort && sort.key === key ? sort.dir : null,
      onSort: cycleSort,
    }),
    [sort, cycleSort],
  );
  // 파생 표시 행 — 정렬 없으면 서버 원본 순서 그대로. 동값은 원본 순서 유지(안정 정렬).
  const displayActs = useMemo(() => {
    if (!sort) return acts;
    const indexed = acts.map((a, i) => ({ a, i }));
    indexed.sort((p, q) => {
      const c = compareIrregularRows(sort.key, sort.dir, p.a, q.a);
      return c !== 0 ? c : p.i - q.i;
    });
    return indexed.map((p) => p.a);
  }, [acts, sort]);

  const summaryCells = useMemo(
    () => [
      { label: "전체 갯수", value: summary.total, helpKey: PROCESS_IRREGULAR_HELP_KEYS.statTotal },
      { label: "링크 신청", value: summary.reviewRequest, accent: "text-purple-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statReviewRequest },
      { label: "수동 부여", value: summary.manualGrant, accent: "text-green-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statManualGrant },
      { label: "체크 완료", value: summary.completed, accent: "text-green-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statCompleted },
      { label: "체크 대기", value: summary.pending, accent: "text-amber-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statPending },
      { label: "전원", value: summary.all, accent: "text-blue-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statAll },
      { label: "부분", value: summary.partial, accent: "text-orange-700", helpKey: PROCESS_IRREGULAR_HELP_KEYS.statPartial },
    ],
    [summary],
  );

  const canAct = Boolean(org) && editable;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      {/* 상단 안내 섹션 — 제목 + 설명 + [전원][부분] 신청 버튼(설명 아래 배치).
          기능(onClick·disabled·색상)·Help Key(pageTitle/buttonReviewAll/buttonPartial)는 그대로 유지. org/mode 무관. */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-1">
                변동 액트 가동 · 신청
                <AdminHelpIconButton
                  helpKey={PROCESS_IRREGULAR_HELP_KEYS.pageTitle}
                  title="변동 액트 가동 · 신청"
                  size="sm"
                />
              </span>
            </CardTitle>
            <AdminHelp />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 설명 문구 — 일반 본문 크기. "링크 신청" 표기 사용(구 "링크 검수" 표현 폐기). */}
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">&lt;변동 액트&gt;</span> 는
            </p>
            <ul className="space-y-1 pl-1">
              <li>
                - [<span className="font-medium text-blue-700">전원</span>] 을 대상으로 할 경우,{" "}
                <span className="font-medium text-foreground">&lt;링크 신청&gt;</span> 으로만 신청이 가능합니다.
              </li>
              <li>
                - [<span className="font-medium text-orange-700">부분</span>] 을 대상으로 할 경우,{" "}
                <span className="font-medium text-foreground">&lt;링크 신청&gt;</span> 또는{" "}
                <span className="font-medium text-foreground">&lt;수동 부여&gt;</span> 로 모두 신청이 가능합니다.
              </li>
            </ul>
          </div>
          {/* 신청 버튼 — [전원](파랑) [부분](주황). 과거 주차(조회 전용)에서는 비활성. 도움말은 버튼 바깥. */}
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                disabled={!canAct}
                onClick={() => setDialog("review-all")}
                className="rounded-md border border-blue-300 bg-blue-50 px-5 py-2 text-sm font-medium text-blue-800 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                전원
              </button>
              <AdminHelpIconButton helpKey={PROCESS_IRREGULAR_HELP_KEYS.buttonReviewAll} title="전원" />
            </div>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                disabled={!canAct}
                onClick={() => setDialog("partial-choice")}
                className="rounded-md border border-orange-300 bg-orange-50 px-5 py-2 text-sm font-medium text-orange-800 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                부분
              </button>
              <AdminHelpIconButton helpKey={PROCESS_IRREGULAR_HELP_KEYS.buttonPartial} title="부분" />
            </div>
          </div>
        </CardContent>
      </Card>

      {!org && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          클럽(?org)이 지정되어야 합니다. 예: <code>/admin/processes/check/irregular?org=oranke</code>
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

      {/* 즉시 검수/실행 취소의 진행 중·완료·실패 안내는 모두 하단 고정 토스트로 표시(인라인 배너 제거). */}

      {/* 주차 선택 — 공용 WeekSelectRow(프로세스 체크와 동일 SoT). */}
      <WeekSelectRow
        weeks={weeks}
        selectedWeekId={selectedWeekId}
        editable={editable}
        value={selValue}
        onChange={setWeekParam}
        disabled={!org}
        selectId="irregular-week-select"
        helpKey={PROCESS_IRREGULAR_HELP_KEYS.filterWeek}
      />

      {/* 통계 7칸 — 1행 7열 칸막이 */}
      <div className="flex divide-x rounded-md border bg-card">
        {summaryCells.map((c) => (
          <SummaryCell key={c.label} label={c.label} value={c.value} accent={c.accent} helpKey={c.helpKey} />
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
            <div>
              <Table containerRef={sticky.ref} regionClassName={sticky.regionClassName} stickyLeft>
                <TableHeader>
                  <TableRow>
                    <HeadCell label="종류" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnKind} sticky={sticky.col(1)} {...headSort("kind")} />
                    <HeadCell label="액트 종류" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnActType} sticky={sticky.col(2)} {...headSort("crewReaction")} />
                    <HeadCell label="액트명(비정규)" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnActName} {...headSort("actName")} />
                    <HeadCell label="신청자" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnApplicant} {...headSort("applicant")} />
                    <HeadCell label="소요 시간(m)" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnDuration} {...headSort("duration")} />
                    <HeadCell label="액트 신청 사유" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnReason} {...headSort("reason")} />
                    <HeadCell label="po A" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnPoA} {...headSort("pointA")} />
                    <HeadCell label="po B" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnPoB} {...headSort("pointB")} />
                    <HeadCell label="po C" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnPoC} {...headSort("pointC")} />
                    {/* 이행 시점(실제) = 신청 시점(실제)+검수 시점(실제) 통합(셀 안 2행).
                        정렬은 신청(createdAt) 기준 — 검수(completedAt) 단독 정렬은 제거. */}
                    <HeadCell label="이행 시점(실제)" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnExecutionTimeActual} {...headSort("createdAt")} />
                    <HeadCell label="체크 상태" helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnStatus} {...headSort("status")} />
                    {/* 즉시 검수 = 액션 컬럼(정렬 제외) — 도움말만. */}
                    <HeadCell
                      label="즉시 검수"
                      helpKey={PROCESS_IRREGULAR_HELP_KEYS.columnManualAction}
                      className="text-center"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayActs.map((a) => (
                    <IrregularRow
                      key={a.id}
                      act={a}
                      onOpenDetail={() => setDetailAct(a)}
                      onImmediateReview={() => handleImmediateReview(a)}
                      reviewing={reviewingId === a.id}
                      onRollback={() => handleRollback(a)}
                      rollbackMode={mode === "test" ? "test" : "operating"}
                      rollingBack={rollingBackId === a.id}
                      actionBusy={anyActionBusy}
                      editable={editable}
                      stickyCol1={sticky.col(1)}
                      stickyCol2={sticky.col(2)}
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
  actionBusy,
  editable,
  stickyCol1,
  stickyCol2,
}: {
  act: ProcessIrregularActRowDto;
  onOpenDetail: () => void;
  onImmediateReview: () => void;
  reviewing: boolean;
  onRollback: () => void;
  rollbackMode: "operating" | "test";
  rollingBack: boolean;
  // 즉시 검수/실행 취소 중 하나라도 진행 중이면 이 행 버튼도 함께 비활성화(상충 요청 차단).
  actionBusy: boolean;
  editable: boolean;
  // 왼쪽 2열 고정(종류·액트 종류) 공통 sticky 계약 props.
  stickyCol1?: StickyColProps;
  stickyCol2?: StickyColProps;
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
      <TableCell
        {...stickyCol1}
        className={cn(stickyCol1?.className)}
      >
        <StatusBadge label={act.kindLabel} size="sm" />
      </TableCell>
      <TableCell
        {...stickyCol2}
        className={cn(stickyCol2?.className)}
      >
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
      <TableCell className={cn("tabular-nums", pointColorClass("a"))}>{act.pointA}</TableCell>
      <TableCell className={cn("tabular-nums", pointColorClass("b"))}>{act.pointB}</TableCell>
      <TableCell className={cn("tabular-nums", pointColorClass("c"))}>{act.pointC}</TableCell>
      {/* 이행 시점(실제) — 신청(createdAt)/검수(completedAt=실제 완료 서버시각) 2행.
          미완료 검수는 "—"(예정 시각 scheduled_check_at 을 실제로 위장하지 않는다). */}
      <TableCell className="whitespace-nowrap text-left text-muted-foreground">
        <ExecutionTimeCell
          apply={act.createdAt ? formatCheckDateTimeKo(act.createdAt) : null}
          review={act.completedAt ? formatCheckDateTimeKo(act.completedAt) : null}
        />
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
          // 크기/여백/높이/라운드는 '실행 취소'(ActionControl size="xs")와 동일한 공용 Button size="xs"
          //   토큰을 재사용하고, 색만 보라 유지(INSTANT_REVIEW_BUTTON_CLASS).
          //   loading=진행 중(스피너+자동 비활성) · disabled=다른 검수/취소 진행 중(상충 차단).
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onImmediateReview}
            loading={reviewing}
            disabled={actionBusy}
            className={INSTANT_REVIEW_BUTTON_CLASS}
            title="검수 시점 전이라도 지금 바로 검수합니다."
          >
            {reviewing ? "검수 중…" : "즉시 검수"}
          </Button>
        ) : canRollback || rollbackBlocked ? (
          <div className="inline-flex justify-center" data-ir-rollback={act.id}>
            <ActionControl
              hideInstant
              size="xs"
              rollbackClass={ACTION_CONTROL_REGISTRY.processIrregularGrant.rollback.class}
              mode={rollbackMode}
              onRollback={onRollback}
              rollbackBusy={rollingBack}
              // 다른 행이 진행 중이면 함께 비활성화(상충 요청 차단). 자신이 진행 중이면 rollbackBusy(스피너)로 표현.
              disabled={actionBusy && !rollingBack}
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
