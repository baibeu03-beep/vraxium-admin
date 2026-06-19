"use client";

// [섹션.1] 액트 목록 테이블 — info/experience 공용. 신청 시점(필요) 순(서버 정렬) · 13컬럼.
//   상태 버튼 클릭 → onOpenAct(act)로 팝업 위임. 실제 시점 = requested_at / scheduled_check_at.

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
import {
  formatCheckDateTimeKo,
  processCheckActStatusLabel,
  type ProcessCheckActRowDto,
} from "@/lib/adminProcessCheckTypes";

export default function ProcessCheckActTable({
  acts,
  loading,
  weekDisabled,
  readOnly = false,
  showScopeColumn = false,
  onOpenAct,
}: {
  acts: ProcessCheckActRowDto[];
  loading: boolean;
  weekDisabled: boolean;
  // 읽기 전용(팀 전체 스코프) — 상태를 버튼이 아닌 비클릭 배지로 표시(체크 신청/취소 불가).
  readOnly?: boolean;
  // "팀 & 파트" 컬럼 표시(experience 만) — 행의 partLabel("팀 총괄"/파트명) 노출.
  showScopeColumn?: boolean;
  onOpenAct: (act: ProcessCheckActRowDto) => void;
}) {
  // 카드 제목/설명(CardHeader) 제거 — 액트 목록(CardContent)만 렌더(info/experience 공용).
  // 요약 — 현재 표시되는 acts(필터/팀/탭 적용 후) 기준 프론트 집계. DB/DTO 무변경.
  //   체크 완료 = status==="completed" · 체크 필요 = 그 외(needed|pending) · 항목 수 = 전체 row.
  const completedCount = acts.filter((a) => a.status === "completed").length;
  const neededCount = acts.length - completedCount;
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
            {/* 액트 목록 요약 — 테이블 바로 위 한 줄(1행 3열). */}
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>
                체크 필요{" "}
                <span className="font-semibold tabular-nums text-amber-700">{neededCount}</span>
              </span>
              <span className="text-muted-foreground">|</span>
              <span>
                체크 완료{" "}
                <span className="font-semibold tabular-nums text-green-700">{completedCount}</span>
              </span>
              <span className="text-muted-foreground">|</span>
              <span>
                항목 수 <span className="font-semibold tabular-nums">{acts.length}</span>
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {showScopeColumn && <TableHead>팀 &amp; 파트</TableHead>}
                  <TableHead>액트명</TableHead>
                  <TableHead>소속 라인 급</TableHead>
                  <TableHead>소요(m)</TableHead>
                  <TableHead>신청 시점(필요)</TableHead>
                  <TableHead>검수 시점(필요)</TableHead>
                  <TableHead>Po.A</TableHead>
                  <TableHead>Po.B</TableHead>
                  <TableHead>Po.C</TableHead>
                  <TableHead>종류</TableHead>
                  <TableHead>카페</TableHead>
                  <TableHead>신청 시점(실제)</TableHead>
                  <TableHead>검수 시점(실제)</TableHead>
                  <TableHead>상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {acts.map((a) => (
                  <TableRow key={`${a.actId}|${a.partLabel}`}>
                    {showScopeColumn && (
                      <TableCell className="whitespace-nowrap font-medium text-muted-foreground">
                        {a.partLabel}
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{a.actName}</TableCell>
                    <TableCell>{a.lineGroupName}</TableCell>
                    <TableCell className="tabular-nums">{a.durationMinutes}</TableCell>
                    <TableCell className="whitespace-nowrap">{a.occurWhen}</TableCell>
                    <TableCell className="whitespace-nowrap">{a.checkWhen}</TableCell>
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
                    <TableCell className="text-center">
                      {a.isCheckTarget ? (
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
