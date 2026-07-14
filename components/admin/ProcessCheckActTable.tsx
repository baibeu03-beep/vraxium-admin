"use client";

// [섹션.1] 액트 목록 테이블 — info/experience/competency/club 공용. 13컬럼(+수동실행).
//   상태 버튼 클릭 → onOpenAct(act)로 팝업 위임. 실제 시점 = requested_at / scheduled_check_at.
//
//   정렬(3단계): 모든 허브 공통 활성. 헤더 클릭 asc → desc → 기본(서버 순서 복귀).
//     원본 acts 는 mutate 하지 않고 파생 복사본만 정렬. 빈값(null/""/"-"/공백)은 오름/내림 모두 마지막.
//     동값은 원본(서버) 순서 유지(안정 정렬). 정렬 아이콘 클릭 = 정렬만 · 돋보기 클릭 = 도움말만(stopPropagation).
//   ⚠ 정렬은 화면 표시 순서만 바꾼다 — 수동 실행/검수/저장 대상은 항상 stable id(a.checkStatusId)로 처리.

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
import { SelectBadge, StatusBadge } from "@/components/ui/status-badge";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
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
  | "scheduledCheckAt"
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
  scheduledCheckAt: { type: "date", get: (a) => a.scheduledCheckAt },
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
  // 읽기 전용(팀 전체 스코프) — 상태를 버튼이 아닌 비클릭 배지로 표시(체크 신청/취소 불가).
  readOnly?: boolean;
  // "팀 & 파트" 컬럼 표시(experience 만) — 행의 partLabel("팀 총괄"/파트명) 노출.
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
  }) => {
    const canSort = Boolean(opts.sortKey);
    const activeDir = sort && opts.sortKey === sort.key ? sort.dir : null;
    return (
      <TableHead className={opts.className}>
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

  return (
    <Card>
      <CardContent>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
        ) : acts.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            등록된 액트가 없습니다. 프로세스 등록 페이지에서 먼저 등록해주세요.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {/* 액트 목록 요약 — 테이블 바로 위 스탯 칩(체크 필요·체크 완료·항목 수). 집계 로직 무변.
                통계 라벨 돋보기는 라벨 1회(반복 행 아님) — 4개 허브 공용 key. */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
                체크 필요
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statNeeded} title="체크 필요" />
                <span className="font-semibold tabular-nums text-amber-700">{neededCount}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
                체크 완료
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statCompleted} title="체크 완료" />
                <span className="font-semibold tabular-nums text-green-700">{completedCount}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
                항목 수
                <AdminHelpIconButton helpKey={PROCESS_CHECK_HELP_KEYS.statTotal} title="항목 수" />
                <span className="font-semibold tabular-nums text-foreground">{acts.length}</span>
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {/* 전체 1~4열 고정: 신청 시점(필요) · 검수 시점(필요) · 상태 · 수동 실행.
                      팀 & 파트(experience)·나머지 열은 그 뒤로. 정렬키/도움말/액션 동작 불변. */}
                  {renderHead({
                    label: "신청 시점(필요)",
                    helpKey: "admin.processCheck.actTable.column.applyTimeRequired",
                    sortKey: "occurWhen",
                  })}
                  {renderHead({
                    label: "검수 시점(필요)",
                    helpKey: "admin.processCheck.actTable.column.reviewTimeRequired",
                    sortKey: "checkWhen",
                  })}
                  {renderHead({
                    label: "상태",
                    helpKey: "admin.processCheck.actTable.column.status",
                    sortKey: "status",
                  })}
                  {(onAutoReview || onRollback) &&
                    renderHead({
                      label: "수동 실행",
                      helpKey: "admin.processCheck.actTable.column.manualAction",
                      className: "text-center",
                    })}
                  {showScopeColumn &&
                    renderHead({
                      label: "팀 & 파트",
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
                    label: "소요(m)",
                    helpKey: "admin.processCheck.actTable.column.duration",
                    sortKey: "durationMinutes",
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
                  {renderHead({
                    label: "신청 시점(실제)",
                    helpKey: "admin.processCheck.actTable.column.applyTimeActual",
                    sortKey: "requestedAt",
                  })}
                  {renderHead({
                    label: "검수 시점(실제)",
                    helpKey: "admin.processCheck.actTable.column.reviewTimeActual",
                    sortKey: "scheduledCheckAt",
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
                    {/* 1열 신청 시점(필요) · 2열 검수 시점(필요) — 헤더와 동일 순서. */}
                    <TableCell className="whitespace-nowrap">{a.occurWhen}</TableCell>
                    <TableCell className="whitespace-nowrap">{a.checkWhen}</TableCell>
                    {/* 3열 상태 — 미가동이면 '미가동' 배지(클릭 불가). 그 외는 클릭/읽기전용/도움말 동작 불변. */}
                    <TableCell className="text-center">
                      {!a.isOpenThisWeek ? (
                        <StatusBadge
                          label="미가동"
                          tone="neutral"
                          size="sm"
                          className="opacity-80"
                          title="이번 주 오픈 대상이 아닙니다(오픈 설정 미포함). 활동 관리에서 오픈된 액트만 체크할 수 있습니다."
                        />
                      ) : a.isCheckTarget ? (
                        readOnly ? (
                          // 팀 전체 스코프 — 읽기 전용 배지(클릭 불가).
                          <StatusBadge
                            label={processCheckActStatusLabel(a.status, a.completionType)}
                            size="sm"
                            className="opacity-70"
                            title="‘팀 전체’ 범위는 읽기 전용입니다. 팀 총괄/파트를 선택하면 체크할 수 있습니다."
                          />
                        ) : (
                          <StatusBadge
                            label={processCheckActStatusLabel(a.status, a.completionType)}
                            size="sm"
                            onClick={() => onOpenAct(a)}
                            disabled={weekDisabled}
                            title={weekDisabled ? "현재 주차 weeks 행 없음" : "클릭하여 체크 신청/취소"}
                          />
                        )
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
                    {/* 5열~ 팀 & 파트(experience) · 나머지 열. */}
                    {showScopeColumn && (
                      <TableCell className="whitespace-nowrap font-medium text-muted-foreground">
                        {a.partLabel}
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{a.actName}</TableCell>
                    {/* 소속 라인 급 — experience(showScopeColumn) 는 긴 라인명이 옆 컬럼을 침범하지
                        않도록 base TableCell 의 whitespace-nowrap 을 whitespace-normal 로 override +
                        break-keep(한글 단어 유지·가능하면 한 줄) + max-w 로 셀 안에 가둔다. 폰트 크기는
                        override 하지 않고 공통 TableCell 기본(text-sm)을 그대로 상속 → 다른 컬럼과 동일.
                        info 는 기존 크기(text-sm·nowrap) 유지. */}
                    <TableCell
                      className={
                        showScopeColumn
                          ? "max-w-[9rem] whitespace-normal break-keep px-2 leading-tight"
                          : undefined
                      }
                    >
                      {a.lineGroupName}
                    </TableCell>
                    <TableCell className="tabular-nums">{a.durationMinutes}</TableCell>
                    <TableCell className="tabular-nums">{a.pointCheck}</TableCell>
                    <TableCell className="tabular-nums">{a.pointAdvantage}</TableCell>
                    <TableCell className="tabular-nums">{a.pointPenalty}</TableCell>
                    <TableCell className="text-center">
                      <SelectBadge label={a.crewReactionLabel} size="sm" />
                    </TableCell>
                    <TableCell>{a.cafeLabel}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {a.requestedAt ? formatCheckDateTimeKo(a.requestedAt) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {a.scheduledCheckAt ? formatCheckDateTimeKo(a.scheduledCheckAt) : "—"}
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
