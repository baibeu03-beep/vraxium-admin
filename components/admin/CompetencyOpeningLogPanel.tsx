"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";
import {
  COMPETENCY_OPENING_LOG_ACTION_LABEL,
  competencyOpeningLogActionClass,
  type CompetencyOpeningLogAction,
} from "@/lib/competencyOpeningLogFormat";

// 실무 역량 [라인 개설] 탭 로그창 — 행동 이력(최신순).
// 표시: [행동] [실무 역량] 허브 전체 - [기간] - {이름} 님 - YY.MM.DD(요일), HH:mm

type LogItem = {
  id: string;
  action: CompetencyOpeningLogAction;
  periodLabel: string;
  actorName: string;
  createdAt: string;
};

export default function CompetencyOpeningLogPanel({
  refreshKey,
}: {
  // 값이 바뀌면 재조회(개설 완료/취소 직후 새 행 반영).
  refreshKey?: number;
}) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 대시보드가 선택한 주차(?week) — 있으면 그 주차 로그를 보여준다(개설 대상 밖 예외 주차 포함).
  //   없으면 서버가 개설 대상 주차로 폴백(기존 동작). 대시보드↔로그창 주차 정합 SoT(실무 경험과 동일).
  const weekId = searchParams?.get("week")?.trim() || null;
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) setLoading(true);
      try {
        const params = new URLSearchParams();
        if (org) params.set("organization", org);
        if (weekId) params.set("week_id", weekId);
        const suffix = params.toString();
        const res = await fetch(
          `/api/admin/cluster4/competency/opening-logs${suffix ? `?${suffix}` : ""}`,
        );
        const json = await res.json();
        if (cancelled) return;
        setLogs(json?.success ? (json.data?.logs ?? []) : []);
      } catch {
        if (!cancelled) setLogs([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, weekId, refreshKey]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">로그창</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 space-y-1.5 overflow-y-auto text-sm">
        {loading ? (
          <LoadingState active variant="inline" />
        ) : logs.length === 0 ? (
          <p className="text-muted-foreground">
            아직 기록된 개설 로그가 없습니다.
          </p>
        ) : (
          logs.map((l) => (
            <p key={l.id} className="text-xs leading-relaxed">
              <span
                className={cn(
                  "font-semibold",
                  competencyOpeningLogActionClass(l.action),
                )}
              >
                [{COMPETENCY_OPENING_LOG_ACTION_LABEL[l.action]}]
              </span>{" "}
              [실무 역량] 허브 전체 - [{l.periodLabel}] - {l.actorName} 님 -{" "}
              {formatLogDateTime(l.createdAt)}
            </p>
          ))
        )}
      </CardContent>
    </Card>
  );
}
