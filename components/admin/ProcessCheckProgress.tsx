"use client";

// 상태창 2(진행 현황) — info/experience 공용. 섹션.0(전체 팀) · 섹션.1(선택 팀) 양쪽에서 재사용.
//   라인급 칩(신청완료=강조) + 라인급/액트 N개 중 M개 체크 신청 완료 2줄.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import type {
  ProcessCheckLineGroupDto,
  ProcessCheckSummary,
} from "@/lib/adminProcessCheckTypes";

function ProgressRow({
  label,
  totalCount,
  completedCount,
}: {
  label: string;
  totalCount: number;
  completedCount: number;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-48">
      <p className="text-sm">{label}</p>
      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="text-sm font-medium text-muted-foreground">{totalCount}개 중</span>
        <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {completedCount}개
        </span>
        <span className="text-sm font-medium text-foreground">체크 신청 완료</span>
      </div>
    </div>
  );
}

export default function ProcessCheckProgress({
  title,
  summary,
  lineGroups,
  helpKey,
}: {
  title: string;
  summary: ProcessCheckSummary;
  lineGroups: ProcessCheckLineGroupDto[];
  // 선택: 카드 제목 옆 돋보기 도움말 key(호출부가 허브별로 결정). 미전달이면 미노출(기존 동작).
  helpKey?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1">
            {title}
            {helpKey && <AdminHelpIconButton helpKey={helpKey} title={title} size="sm" />}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <ProgressRow
            label="이번 주 체크 필요 [라인 급] 프로세스"
            totalCount={summary.lineGroupTotal}
            completedCount={summary.lineGroupApplied}
          />
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
                    g.isCompleted
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
        <div className="space-y-3 border-t border-border pt-5">
          <ProgressRow
            label="이번 주 체크 필요 [액트] 프로세스"
            totalCount={summary.actTotal}
            completedCount={summary.actApplied}
          />
        </div>
      </CardContent>
    </Card>
  );
}
