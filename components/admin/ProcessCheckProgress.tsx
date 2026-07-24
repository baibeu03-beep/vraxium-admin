"use client";

// 상태창 2(진행 현황) — info/experience 공용. 섹션.0(전체 팀) · 섹션.1(선택 팀) 양쪽에서 재사용.
//   라인급 칩(신청완료=강조) + 라인급/액트 N개 중 M개 체크 신청 완료 2줄.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { statusTokenClass } from "@/components/admin/lineOpeningStatusUi";
import type {
  ProcessCheckLineGroupDto,
  ProcessCheckSummary,
} from "@/lib/adminProcessCheckTypes";

// 진행 현황 강조 — 전부 빨강(<Red>) 단일 강조 폐지. 역할 구분:
//   분모(전체 개수) = 정보성 → 색 없이 굵게만 / 신청 완료 개수 = 초록(statusTokenClass "crewOk").
//   라인 개설·프로세스 체크 상태창과 동일한 색 SoT. 표시 계층 전용(summary 계산 무변).
function Total({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-foreground">{children}</span>;
}
function Done({ children }: { children: React.ReactNode }) {
  return <span className={statusTokenClass("crewOk")}>{children}</span>;
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
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1">
            {title}
            {helpKey && <AdminHelpIconButton helpKey={helpKey} title={title} size="sm" />}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm">
            이번 주 체크 필요 [라인 급] 프로세스 <Total>{summary.lineGroupTotal}</Total>개 중{" "}
            <Done>{summary.lineGroupApplied}</Done>개 체크 신청 완료
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
        <div className="space-y-1 border-t border-border pt-4">
          <p className="text-sm">
            이번 주 체크 필요 [액트] 프로세스 <Total>{summary.actTotal}</Total>개 중{" "}
            <Done>{summary.actApplied}</Done>개 체크 신청 완료
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
