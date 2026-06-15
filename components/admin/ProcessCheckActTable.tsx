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
import { cn } from "@/lib/utils";
import {
  formatCheckDateTimeKo,
  processCheckButtonClass,
  processCheckButtonLabel,
  type ProcessCheckActRowDto,
} from "@/lib/adminProcessCheckTypes";

export default function ProcessCheckActTable({
  acts,
  loading,
  weekDisabled,
  onOpenAct,
}: {
  acts: ProcessCheckActRowDto[];
  loading: boolean;
  weekDisabled: boolean;
  onOpenAct: (act: ProcessCheckActRowDto) => void;
}) {
  // 카드 제목/설명(CardHeader) 제거 — 액트 목록(CardContent)만 렌더(info/experience 공용).
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>액트명</TableHead>
                  <TableHead>소속 라인 급</TableHead>
                  <TableHead className="text-right">소요(m)</TableHead>
                  <TableHead>신청 시점(필요)</TableHead>
                  <TableHead>검수 시점(필요)</TableHead>
                  <TableHead className="text-right">Po.A</TableHead>
                  <TableHead className="text-right">Po.B</TableHead>
                  <TableHead className="text-right">Po.C</TableHead>
                  <TableHead>크루 반응</TableHead>
                  <TableHead>카페</TableHead>
                  <TableHead>신청 시점(실제)</TableHead>
                  <TableHead>검수 시점(실제)</TableHead>
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
                          onClick={() => onOpenAct(a)}
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
  );
}
