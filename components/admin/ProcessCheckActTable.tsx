"use client";

// [섹션.1] 액트 목록 테이블 — info/experience/competency/club 공용. 13컬럼(+수동실행).
//   상태 버튼 클릭 → onOpenAct(act)로 팝업 위임. 실제 시점 = requested_at / scheduled_check_at.
//
//   정렬(3단계): 모든 허브 공통 활성. 헤더 클릭 asc → desc → 기본(서버 순서 복귀).
//     원본 acts 는 mutate 하지 않고 파생 복사본만 정렬. 빈값(null/""/"-"/공백)은 오름/내림 모두 마지막.
//     동값은 원본(서버) 순서 유지(안정 정렬). 정렬 아이콘 클릭 = 정렬만 · 돋보기 클릭 = 도움말만(stopPropagation).
//   ⚠ 정렬은 화면 표시 순서만 바꾼다 — 수동 실행/검수/저장 대상은 항상 stable id(a.checkStatusId)로 처리.
//
//   셀 표현 SoT(2026-07-27) — 페이지별 색 조건문 금지. 아래 공용 진입점만 사용한다.
//     소속 라인 급 · 카페 = ValueBadge(category, value) → lib/statusBadge.valueTone
//         색 키 = `${category}:${value}` (렌더 순서 무관 · 조직/허브/모드 무관 · 빈값은 배지 없음)
//     종류        = SelectBadge(label)   → lib/statusBadge.statusTone (프로세스 등록 화면과 동일 매핑)
//     po.A/B/C(별·방패·번개) = pointColorClass("a"|"b"|"c") → components/ui/point-value
//         A/B=text-point-good · C=text-point-danger (globals.css --point-good/--point-danger, light/dark)
//   ⚠ 이 파일에는 mode/actAsTestUserId/조직 슬러그 분기가 없다 — 일반·테스트 모드가 같은 셀 렌더러를 탄다.

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectBadge, StatusBadge, ValueBadge } from "@/components/ui/status-badge";
import { pointColorClass } from "@/components/ui/point-value";
import { useStickyColumns } from "@/components/ui/sticky-columns";
import { cn } from "@/lib/utils";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
// 카드 표현·배지 색 — /admin/integrated/line-opening/* 과 동일한 공용 SoT 재사용(신규 스타일 정의 없음).
import {
  completionCardTone,
  lineOpeningCardClass,
  lineOpeningCardTopBandClass,
} from "@/components/admin/lineOpeningCardStyles";
import { lineManagementBadgeClass } from "@/components/admin/lineManagementTone";
import CommentCollectionStatusView from "@/components/admin/CommentCollectionStatusView";
import ExecutionTimeCell from "@/components/admin/ExecutionTimeCell";
import { ActionControl, INSTANT_REVIEW_BUTTON_CLASS } from "@/components/admin/ActionControl";
import { ACTION_CONTROL_REGISTRY } from "@/lib/actionControl/registry";
import {
  PROCESS_CHECK_HELP_KEYS,
  formatCheckDateTimeKo,
  processCheckActStatusLabel,
  type ProcessCheckActRowDto,
  type ProcessCheckStatus,
} from "@/lib/adminProcessCheckTypes";
import { getProcessPointLabels } from "@/lib/pointLabels";

// ── 정렬 메타(순수) — 컬럼 key ↔ 값 추출 + 데이터 타입. 표시 문자열이 아니라 원본 필드를 기준한다. ──
type ActSortKey =
  | "partLabel"
  | "actName"
  | "lineGroupName"
  | "durationMinutes"
  | "occurWhen"
  | "checkWhen"
  | "pointCheck"
  | "pointAdvantage"
  | "pointPenalty"
  | "kind"
  | "cafeLabel"
  | "requestedAt"
  | "completedAt"
  | "status";
type ActSortDir = "asc" | "desc";
type ActSortType = "string" | "number" | "date" | "status";

// 상태 업무 순서 — 체크 필요(needed) → 체크 대기(pending) → 체크 완료(completed).
const ACT_STATUS_ORDER: Record<ProcessCheckStatus, number> = { needed: 0, pending: 1, completed: 2 };

const ACT_SORT_META: Record<
  ActSortKey,
  { type: ActSortType; get: (a: ProcessCheckActRowDto) => string | number | null }
> = {
  partLabel: { type: "string", get: (a) => a.partLabel },
  actName: { type: "string", get: (a) => a.actName },
  lineGroupName: { type: "string", get: (a) => a.lineGroupName },
  durationMinutes: { type: "number", get: (a) => a.durationMinutes },
  occurWhen: { type: "string", get: (a) => a.occurWhen },
  checkWhen: { type: "string", get: (a) => a.checkWhen },
  pointCheck: { type: "number", get: (a) => a.pointCheck },
  pointAdvantage: { type: "number", get: (a) => a.pointAdvantage },
  pointPenalty: { type: "number", get: (a) => a.pointPenalty },
  kind: { type: "string", get: (a) => a.crewReactionLabel },
  cafeLabel: { type: "string", get: (a) => a.cafeLabel },
  requestedAt: { type: "date", get: (a) => a.requestedAt },
  // 검수 시점(실제) = 실제 검수가 완료된 서버 시각(completed_at). 예정값(scheduled_check_at) 아님.
  completedAt: { type: "date", get: (a) => a.completedAt },
  status: { type: "status", get: (a) => a.status },
};

// 빈값 판정 — null/undefined/""/공백/"-" · 숫자 NaN · 날짜 파싱 불가. (숫자 0 은 유효값)
function actValueIsEmpty(type: ActSortType, raw: string | number | null): boolean {
  if (raw === null || raw === undefined) return true;
  if (type === "number") return Number.isNaN(raw as number);
  if (type === "date") return Number.isNaN(Date.parse(String(raw)));
  const s = String(raw).trim();
  return s === "" || s === "-";
}

// 두 행 비교 — 빈값은 방향 무관 항상 마지막. 그 외는 타입별 비교 후 방향 반영.
function compareActRows(
  key: ActSortKey,
  dir: ActSortDir,
  x: ProcessCheckActRowDto,
  y: ProcessCheckActRowDto,
): number {
  const meta = ACT_SORT_META[key];
  const rawA = meta.get(x);
  const rawB = meta.get(y);
  const emptyA = actValueIsEmpty(meta.type, rawA);
  const emptyB = actValueIsEmpty(meta.type, rawB);
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1; // 빈값 → 항상 마지막
  if (emptyB) return -1;
  let c = 0;
  if (meta.type === "number") c = (rawA as number) - (rawB as number);
  else if (meta.type === "date") c = Date.parse(String(rawA)) - Date.parse(String(rawB));
  else if (meta.type === "status")
    c = ACT_STATUS_ORDER[rawA as ProcessCheckStatus] - ACT_STATUS_ORDER[rawB as ProcessCheckStatus];
  else c = String(rawA).localeCompare(String(rawB), "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

function ActSortIcon({ dir }: { dir: ActSortDir | null }) {
  if (dir === "asc") return <ChevronUp className="h-3.5 w-3.5" aria-hidden />;
  if (dir === "desc") return <ChevronDown className="h-3.5 w-3.5" aria-hidden />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden />;
}

export default function ProcessCheckActTable({
  acts,
  loading,
  weekDisabled,
  readOnly = false,
  showScopeColumn = false,
  orgSlug = null,
  onOpenAct,
  onAutoReview,
  autoReviewingId = null,
  onRollback,
  rollbackingId = null,
  actionBusy = false,
  rollbackMode = "operating",
}: {
  acts: ProcessCheckActRowDto[];
  loading: boolean;
  weekDisabled: boolean;
  // po.A/B/C 표시명을 조직별로 치환하기 위한 현재 조직 slug(?org). 없으면 중립 표기.
  orgSlug?: string | null;
  // 읽기 전용(팀 종합 스코프) — 상태를 버튼이 아닌 비클릭 배지로 표시(체크 신청/취소 불가).
  readOnly?: boolean;
  // "파트 구분" 컬럼 표시(experience 만) — 행의 partLabel("팀 총괄"/파트명) 노출.
  showScopeColumn?: boolean;
  onOpenAct: (act: ProcessCheckActRowDto) => void;
  // QA '자동 검수'(행 단위) — '체크 대기' 행을 지금 즉시 검수. 미전달이면 버튼 미노출.
  onAutoReview?: (act: ProcessCheckActRowDto) => void;
  // 현재 자동 검수 중인 행의 checkStatusId(스피너/중복클릭 방지). 없으면 null.
  autoReviewingId?: string | null;
  // ↩ 실행 취소(행 단위) — '체크 완료' 행을 직전 단계(pending)로 되돌린다. 미전달이면 버튼 미노출.
  onRollback?: (act: ProcessCheckActRowDto) => void | Promise<void>;
  // 현재 실행 취소 중인 행의 checkStatusId(스피너/중복방지). 없으면 null.
  rollbackingId?: string | null;
  // 즉시 검수/실행 취소 중 하나라도 진행 중이면 true — 관련 버튼을 함께 비활성화(상충 요청 차단).
  actionBusy?: boolean;
  // 실행 취소 확인 모달의 운영/테스트 표기.
  rollbackMode?: "operating" | "test";
}) {
  // 카드 제목/설명(CardHeader) 제거 — 액트 목록(CardContent)만 렌더(공용).
  // 요약 — 현재 표시되는 acts(필터/팀/탭 적용 후) 기준 프론트 집계. DB/DTO 무변경.
  //   ⚠ 미가동(!isOpenThisWeek) 액트는 이번 주 오픈 대상이 아니므로 체크 필요/체크 완료 집계에서 제외한다.
  //     (목록에는 계속 표시되지만 집계 대상이 아니다 — 서버 요약과 동일 기준.) 항목 수 = 전체 표시 row.
  const openTargets = acts.filter((a) => a.isOpenThisWeek && a.isCheckTarget);
  const completedCount = openTargets.filter((a) => a.status === "completed").length;
  const neededCount = openTargets.length - completedCount;
  const poLabels = getProcessPointLabels(orgSlug);

  // 왼쪽 2열 고정(이행 시점(필요)·상태) — 공통 sticky 계약. col-1 실측폭으로 col-2 offset.
  const sticky = useStickyColumns({ headerSticky: true });

  // 정렬 상태 — null = 서버 기본 순서(신청 시점 필요 순). 모든 허브 공통 활성.
  const [sort, setSort] = useState<{ key: ActSortKey; dir: ActSortDir } | null>(null);
  const cycleSort = useCallback((key: ActSortKey) => {
    // 3단계 순환: 없음/타열 → asc → desc → 기본(null) 복귀.
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);

  // 파생 표시 행 — 정렬 없으면 서버 원본 순서 그대로. 원본 acts 는 절대 mutate 하지 않는다.
  const displayActs = useMemo(() => {
    if (!sort) return acts;
    const indexed = acts.map((a, i) => ({ a, i }));
    indexed.sort((p, q) => {
      const c = compareActRows(sort.key, sort.dir, p.a, q.a);
      return c !== 0 ? c : p.i - q.i; // 동값 = 원본(서버) 순서 유지(안정 정렬)
    });
    return indexed.map((p) => p.a);
  }, [acts, sort]);

  // 헤더 셀 — sortKey 가 있으면 라벨을 정렬 버튼으로(모든 허브), 없으면 정적 라벨로 렌더.
  //   돋보기(AdminHelpIconButton)는 항상 정렬 버튼 바깥 — 클릭 영역이 겹치지 않는다.
  const renderHead = (opts: {
    label: string;
    helpKey: string;
    sortKey?: ActSortKey;
    className?: string;
    stickyCol?: 1 | 2;
  }) => {
    const canSort = Boolean(opts.sortKey);
    const activeDir = sort && opts.sortKey === sort.key ? sort.dir : null;
    const stickyProps = opts.stickyCol ? sticky.col(opts.stickyCol) : null;
    return (
      <TableHead
        className={cn(opts.className, stickyProps?.className)}
        data-sticky-col={stickyProps?.["data-sticky-col"]}
      >
        <span className="inline-flex items-center justify-center gap-1">
          {canSort ? (
            <button
              type="button"
              onClick={() => cycleSort(opts.sortKey!)}
              aria-label={`${opts.label} 정렬`}
              className="inline-flex cursor-pointer items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-500/40"
            >
              <span>{opts.label}</span>
              <ActSortIcon dir={activeDir} />
            </button>
          ) : (
            <span>{opts.label}</span>
          )}
          <AdminHelpIconButton helpKey={opts.helpKey} title={opts.label} />
        </span>
      </TableHead>
    );
  };

  // 카드 tone — 이번 주 오픈 대상(openTargets) 기준. 전부 완료=에메랄드 / 남음=앰버 / 대상 0건=중립.
  //   ⚠ 집계식(openTargets/completedCount)은 위에서 이미 계산된 값을 그대로 쓴다 — 판정 로직 무변경.
  const cardTone = completionCardTone({
    total: openTargets.length,
    allCompleted: neededCount === 0,
  });

  return (
    <Card className={lineOpeningCardClass(cardTone)}>
      <CardContent>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
        ) : acts.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            등록된 액트가 없습니다. 프로세스 등록 페이지에서 먼저 등록해주세요.
          </p>
        ) : (
          <div>
            {/* 액트 목록 요약 — 테이블 바로 위 스탯 칩(체크 필요·체크 완료·항목 수). 집계 로직 무변.
                통계 라벨 돋보기는 라벨 1회(반복 행 아님) — 4개 허브 공용 key. */}
            {/* 이 카드는 CardHeader 가 없다 — 요약 칩 줄을 공용 '상단 밴드'(틴트 + 하단 경계선)로 만들어
                헤더와 본문(표)의 시각 분리를 라인 개설 카드와 동일하게 맞춘다. 음수 마진 상쇄 방식이라
                칩의 화면 위치는 적용 전과 동일하다(레이아웃 좌표 불변). 칩 색은 공용 배지 tone SoT. */}
            <div
              // 검증 스크립트(browser-verify-process-check-card-design)가 밴드 위치를 실측하는 훅.
              data-pc-band=""
              className={lineOpeningCardTopBandClass(
                cardTone,
                "mb-3 flex flex-wrap items-center gap-2 border-b border-foreground/10 pb-3 text-sm",
              )}
            >
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
                  lineManagementBadgeClass("warning"),
                )}
              >
                체크 필요
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statNeeded} title="체크 필요" />
                <span className="font-semibold tabular-nums">{neededCount}</span>
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
                  lineManagementBadgeClass("success"),
                )}
              >
                체크 완료
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statCompleted} title="체크 완료" />
                <span className="font-semibold tabular-nums">{completedCount}</span>
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
                  lineManagementBadgeClass("neutral"),
                )}
              >
                항목 수
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statTotal} title="항목 수" />
                <span className="font-semibold tabular-nums">{acts.length}</span>
              </span>
            </div>
            <Table containerRef={sticky.ref} regionClassName={sticky.regionClassName} stickyLeft>
              <TableHeader>
                <TableRow>
                  {/* 전체 1~3열 고정: 이행 시점(필요) · 상태 · 수동 실행.
                      이행 시점(필요) = 신청 시점(필요)+검수 시점(필요) 통합(셀 안 2행).
                      정렬은 신청(occurWhen) 기준 — 검수(checkWhen) 단독 정렬은 제거.
                      파트 구분(experience)·나머지 열은 그 뒤로. 도움말/액션 동작 불변. */}
                  {renderHead({
                    label: "이행 시점(필요)",
                    helpKey: "admin.processCheck.actTable.column.executionTimeRequired",
                    sortKey: "occurWhen",
                    stickyCol: 1,
                  })}
                  {renderHead({
                    label: "상태",
                    helpKey: "admin.processCheck.actTable.column.status",
                    sortKey: "status",
                    stickyCol: 2,
                  })}
                  {(onAutoReview || onRollback) &&
                    renderHead({
                      label: "수동 실행",
                      helpKey: "admin.processCheck.actTable.column.manualAction",
                      className: "text-center",
                    })}
                  {showScopeColumn &&
                    renderHead({
                      label: "파트 구분",
                      helpKey: "admin.processCheck.actTable.column.teamPart",
                      sortKey: "partLabel",
                    })}
                  {renderHead({
                    label: "액트명",
                    helpKey: "admin.processCheck.actTable.column.actName",
                    sortKey: "actName",
                  })}
                  {renderHead({
                    label: "소속 라인 급",
                    helpKey: "admin.processCheck.actTable.column.lineGroup",
                    sortKey: "lineGroupName",
                  })}
                  {renderHead({
                    // 표시 문구 SoT = "소요 시간(m)". 정렬 aria-label·도움말 제목도 이 label 을 쓴다.
                    label: "소요 시간(m)",
                    helpKey: "admin.processCheck.actTable.column.duration",
                    sortKey: "durationMinutes",
                    className: "whitespace-nowrap",
                  })}
                  {renderHead({
                    label: poLabels.a,
                    helpKey: "admin.processCheck.actTable.column.poA",
                    sortKey: "pointCheck",
                  })}
                  {renderHead({
                    label: poLabels.b,
                    helpKey: "admin.processCheck.actTable.column.poB",
                    sortKey: "pointAdvantage",
                  })}
                  {renderHead({
                    label: poLabels.c,
                    helpKey: "admin.processCheck.actTable.column.poC",
                    sortKey: "pointPenalty",
                  })}
                  {renderHead({
                    label: "종류",
                    helpKey: "admin.processCheck.actTable.column.kind",
                    sortKey: "kind",
                  })}
                  {renderHead({
                    label: "카페",
                    helpKey: "admin.processCheck.actTable.column.cafe",
                    sortKey: "cafeLabel",
                  })}
                  {/* 이행 시점(실제) = 신청 시점(실제)+검수 시점(실제) 통합(셀 안 2행).
                      정렬은 신청(requestedAt) 기준 — 검수(completedAt) 단독 정렬은 제거. */}
                  {renderHead({
                    label: "이행 시점(실제)",
                    helpKey: "admin.processCheck.actTable.column.executionTimeActual",
                    sortKey: "requestedAt",
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayActs.map((a) => (
                  // 미가동(!isOpenThisWeek) 행은 이번 주 오픈 대상이 아님 — 확실히 어둡게 처리(조작 차단).
                  <TableRow
                    key={`${a.actId}|${a.partLabel}`}
                    className={
                      a.isOpenThisWeek
                        ? undefined
                        : "bg-muted/60 text-muted-foreground [&>td]:opacity-70"
                    }
                  >
                    {/* 1열 이행 시점(필요) — 신청(occurWhen)/검수(checkWhen) 2행. 좌측 고정 col-1. */}
                    <TableCell
                      {...sticky.col(1)}
                      className={cn("whitespace-nowrap text-left", sticky.col(1).className)}
                    >
                      <ExecutionTimeCell apply={a.occurWhen} review={a.checkWhen} />
                    </TableCell>
                    {/* 2열 상태 — 미가동이면 '미가동' 배지(클릭 불가). 그 외는 클릭/읽기전용/도움말 동작 불변.
                        배지 아래 보조: 댓글 수집/매칭 카운트 + 수집 상태(정상 0·매칭 없음·일시 오류 구분). 좌측 고정 col-2. */}
                    <TableCell
                      {...sticky.col(2)}
                      className={cn("text-center", sticky.col(2).className)}
                    >
                      {!a.isOpenThisWeek ? (
                        <StatusBadge
                          label="미가동"
                          tone="neutral"
                          size="sm"
                          className="opacity-80"
                          title="이번 주 오픈 대상이 아닙니다(오픈 설정 미포함). 활동 관리에서 오픈된 액트만 체크할 수 있습니다."
                        />
                      ) : a.isCheckTarget ? (
                        <div className="inline-flex flex-col items-center gap-0.5">
                          {readOnly ? (
                            // 팀 종합 스코프 — 읽기 전용 배지(클릭 불가).
                            <StatusBadge
                              label={processCheckActStatusLabel(a.status, a.completionType)}
                              size="sm"
                              className="opacity-70"
                              title="‘팀 종합’은 읽기 전용입니다. 팀 총괄 또는 파트를 선택하면 체크할 수 있습니다."
                            />
                          ) : (
                            <StatusBadge
                              label={processCheckActStatusLabel(a.status, a.completionType)}
                              size="sm"
                              onClick={() => onOpenAct(a)}
                              disabled={weekDisabled}
                              title={weekDisabled ? "현재 주차 weeks 행 없음" : "클릭하여 체크 신청/취소"}
                            />
                          )}
                          {/* 신청 후(대기/완료) 행만 수집 상태 보조 표시 — needed 는 아직 수집 개념이 없음. */}
                          {a.status !== "needed" && (
                            <CommentCollectionStatusView debug={a.reviewerDebug} variant="compact" />
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">체크 대상 아님</span>
                      )}
                    </TableCell>
                    {/* 4열 '수동 실행' — 대기(pending)=⚡즉시 검수 / 완료(completed)=↩실행 취소(직전 단계 복원). */}
                    {(onAutoReview || onRollback) && (
                      <TableCell className="text-center">
                        {/* 미가동 액트는 즉시 검수/실행 취소 등 수동 실행을 노출하지 않는다(조작 차단). */}
                        {!a.isOpenThisWeek ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : !readOnly && onAutoReview && a.isCheckTarget && a.status === "pending" && a.checkStatusId ? (
                          // 크기/여백/높이/라운드는 '실행 취소'(ActionControl size="xs")와 동일한 공용
                          //   Button size="xs" 토큰을 재사용하고, 색만 보라 유지(INSTANT_REVIEW_BUTTON_CLASS).
                          //   loading=진행 중(스피너+자동 비활성) · disabled=다른 검수/취소 진행 중(상충 차단).
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => onAutoReview(a)}
                            loading={autoReviewingId === a.checkStatusId}
                            disabled={weekDisabled || actionBusy}
                            className={INSTANT_REVIEW_BUTTON_CLASS}
                            title="검수 시점 전이라도 지금 바로 검수합니다."
                          >
                            {autoReviewingId === a.checkStatusId ? "검수 중…" : "즉시 검수"}
                          </Button>
                        ) : !readOnly && onRollback && a.status === "completed" && a.checkStatusId ? (
                          <div className="inline-flex justify-center" data-pc-rollback={a.checkStatusId}>
                            <ActionControl
                              hideInstant
                              size="xs"
                              rollbackClass={ACTION_CONTROL_REGISTRY.processCheckComplete.rollback.class}
                              mode={rollbackMode}
                              onRollback={() => onRollback(a)}
                              rollbackBusy={rollbackingId === a.checkStatusId}
                              // 다른 행이 진행 중이면 함께 비활성화(상충 요청 차단). 자신이 진행 중이면
                              //   rollbackBusy(스피너)로 표현되므로 disabled 로 이중 처리하지 않는다.
                              disabled={actionBusy && rollbackingId !== a.checkStatusId}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    {/* 5열~ 파트 구분(experience) · 나머지 열. */}
                    {showScopeColumn && (
                      <TableCell className="whitespace-nowrap font-medium text-muted-foreground">
                        {a.partLabel}
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{a.actName}</TableCell>
                    {/* 소속 라인 급 — 분류값 배지(ValueBadge/valueTone). 색은 `lineGroup:<값>` 해시로만
                        결정되므로 정렬·필터·페이지 이동·재렌더 후에도 같은 라인급 = 항상 같은 색이고,
                        조직/허브가 달라도 동일하다. 값이 비면("-"/공백) 배지 없이 기존 빈 값 표기 유지.
                        ⚠ 허브별(showScopeColumn) 줄바꿈 분기는 제거 — 배지는 whitespace-nowrap 이 기본이라
                        4개 허브가 같은 셀 렌더러를 탄다(일반/테스트 모드 포함 단일 경로). */}
                    <TableCell className="text-center">
                      <ValueBadge category="lineGroup" value={a.lineGroupName} />
                    </TableCell>
                    <TableCell className="tabular-nums">{a.durationMinutes}</TableCell>
                    {/* po.A/B/C 셀값 색 = 어드민 전역 포인트 색 SoT(components/ui/point-value).
                        A(별)·B(방패)=text-point-good(초록) / C(번개)=text-point-danger(빨강).
                        값 0 도 같은 색을 유지한다(색은 부호가 아니라 포인트 종류로 정한다). */}
                    <TableCell className={cn("tabular-nums", pointColorClass("a"))}>{a.pointCheck}</TableCell>
                    <TableCell className={cn("tabular-nums", pointColorClass("b"))}>{a.pointAdvantage}</TableCell>
                    <TableCell className={cn("tabular-nums", pointColorClass("c"))}>{a.pointPenalty}</TableCell>
                    {/* 종류 = 액트 종류 라벨(필수/선별/자율/기타). 프로세스 등록 화면과 같은
                        SelectBadge + lib/statusBadge 레지스트리 → 두 화면의 같은 값이 같은 색. */}
                    <TableCell className="text-center">
                      <SelectBadge label={a.crewReactionLabel} size="sm" />
                    </TableCell>
                    {/* 카페 = 발생/미발생. 프로세스 등록 화면과 동일한 category="cafe" 키를 써서
                        같은 값이 같은 색(발생=success · 미발생=neutral)이 되도록 한다. */}
                    <TableCell className="text-center">
                      <ValueBadge category="cafe" value={a.cafeLabel} />
                    </TableCell>
                    {/* 이행 시점(실제) — 신청(requestedAt)/검수(completedAt=실제 완료 서버시각) 2행.
                        미완료 검수는 "—"(예정 시각 scheduled_check_at 을 실제로 위장하지 않는다). */}
                    <TableCell className="whitespace-nowrap text-left text-muted-foreground">
                      <ExecutionTimeCell
                        apply={a.requestedAt ? formatCheckDateTimeKo(a.requestedAt) : null}
                        review={a.completedAt ? formatCheckDateTimeKo(a.completedAt) : null}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
