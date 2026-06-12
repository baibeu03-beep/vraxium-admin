"use client";

// 상태창 2(진행 현황) — info/experience 공용. 섹션.0(전체 팀) · 섹션.1(선택 팀) 양쪽에서 재사용.
//   라인급 칩(신청완료=강조) + 라인급/액트 N개 중 M개 체크 신청 완료 2줄.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  ProcessCheckLineGroupDto,
  ProcessCheckSummary,
} from "@/lib/adminProcessCheckTypes";

function Red({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-red-600">{children}</span>;
}

export default function ProcessCheckProgress({
  title,
  summary,
  lineGroups,
}: {
  title: string;
  summary: ProcessCheckSummary;
  lineGroups: ProcessCheckLineGroupDto[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm">
            이번 주 체크 필요 [라인 급] 프로세스 <Red>{summary.lineGroupTotal}</Red>개 중{" "}
            <Red>{summary.lineGroupApplied}</Red>개 체크 신청 완료
          </p>
          {lineGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">체크 대상 라인급이 없습니다.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {lineGroups.map((g) => (
                <span
                  key={g.lineGroupId}
                  title={`체크 대상 액트 ${g.appliedActCount}/${g.targetActCount} 신청완료`}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium",
                    g.hasApplied
                      ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                      : "border-border bg-background text-muted-foreground",
                  )}
                >
                  {g.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm">
            이번 주 체크 필요 [액트] 프로세스 <Red>{summary.actTotal}</Red>개 중{" "}
            <Red>{summary.actApplied}</Red>개 체크 신청 완료
          </p>
          <p className="text-xs text-muted-foreground">
            (체크 완료 {summary.actCompleted}개 · 신청완료 = 체크 신청 또는 체크 완료)
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
