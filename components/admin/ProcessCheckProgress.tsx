"use client";

// 상태창 2(진행 현황) — info/experience 공용. 섹션.0(전체 팀) · 섹션.1(선택 팀) 양쪽에서 재사용.
//   라인급 칩(신청완료=강조) + 라인급/액트 N개 중 M개 체크 신청 완료 2줄.
//
// 디자인: /admin/integrated/line-opening/* 과 동일한 공용 카드 SoT(lineOpeningCardStyles) 재사용 —
//   좌측 accent + 헤더 틴트 + 제목 도트. tone 은 진행 상태에 따라 완료=에메랄드 / 남음=앰버 /
//   대상 0건=중립(completionCardTone). 요약 수치 2줄은 내부 요약 박스로 감싸 정보 영역과 구분한다.
//   ⚠ summary/lineGroups 계산·DTO·API 는 건드리지 않는다(표시 계층 전용).

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  LineOpeningCardDot,
  completionCardTone,
  lineOpeningCardClass,
  lineOpeningCardHeaderClass,
} from "@/components/admin/lineOpeningCardStyles";
import { lineManagementBadgeClass } from "@/components/admin/lineManagementTone";
import { LineOpeningNotOpenNotice } from "@/components/admin/lineOpeningStatusUi";
import type {
  ProcessCheckLineGroupDto,
  ProcessCheckSummary,
} from "@/lib/adminProcessCheckTypes";

// 내부 요약 박스 — 라인 개설 화면의 요약 박스와 동일 규격(rounded-md border bg-muted/30).
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
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:gap-48">
      {/* min-w-0 — 좁은 폭(태블릿)에서 고정 gap 과 함께 넘치지 않고 자연스럽게 줄바꿈되도록. */}
      <p className="min-w-0 text-sm">{label}</p>
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
  notOpen = false,
}: {
  title: string;
  summary: ProcessCheckSummary;
  lineGroups: ProcessCheckLineGroupDto[];
  // 선택: 카드 제목 옆 돋보기 도움말 key(호출부가 허브별로 결정). 미전달이면 미노출(기존 동작).
  helpKey?: string;
  // 이 주차·스코프가 아직 오픈되지 않았는가 — 판정은 호출부(공용 resolveProcessCheckOpenState)가 소유한다.
  //   true 면 라인급 빈 목록 문구를 "일반 빈 상태" 대신 미오픈 사유로 바꾼다(원인 오해 방지).
  notOpen?: boolean;
}) {
  // 카드 tone — 라인급/액트 두 축을 합친 전체 진행 상태 기준(완료 판정 자체는 서버 summary 가 SoT).
  const tone = completionCardTone({
    total: summary.lineGroupTotal + summary.actTotal,
    allCompleted:
      summary.lineGroupApplied >= summary.lineGroupTotal &&
      summary.actApplied >= summary.actTotal,
  });
  return (
    <Card className={lineOpeningCardClass(tone, "h-full")}>
      <CardHeader className={lineOpeningCardHeaderClass(tone)}>
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1">
            <LineOpeningCardDot tone={tone} />
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
            // 미오픈 = "아직 오픈되지 않았습니다"(원인 명시) / 오픈+대상 0건 = 기존 빈 상태 문구 유지.
            notOpen ? (
              <LineOpeningNotOpenNotice description="이 주차가 오픈되면 체크 대상 라인급이 표시됩니다." />
            ) : (
              <p className="text-sm text-muted-foreground">체크 대상 라인급이 없습니다.</p>
            )
          ) : (
            <div className="flex flex-wrap gap-2">
              {lineGroups.map((g) => (
                <span
                  key={g.lineGroupId}
                  title={`체크 대상 액트 ${g.appliedActCount}/${g.targetActCount} 신청완료`}
                  // 신청완료=success(에메랄드) · 미완료=neutral(슬레이트) — 공용 배지 tone SoT(다크 대응).
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium",
                    lineManagementBadgeClass(g.isCompleted ? "success" : "neutral"),
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
