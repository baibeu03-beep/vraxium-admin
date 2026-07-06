"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";
import {
  EXPERIENCE_OPENING_LOG_ACTION_LABEL,
  experienceOpeningLogActionClass,
  type ExperienceOpeningLogAction,
} from "@/lib/experienceOpeningLogFormat";

// 실무 경험 라인 개설 [라인 개설] 탭 로그창 — 행동 이력(최신순).
// 표시: [행동] [기간] - {팀} ㅣ {파트} ㅣ {크루상태} ㅣ {이름} 님 - YY.MM.DD(요일), HH:mm

type LogItem = {
  id: string;
  action: ExperienceOpeningLogAction;
  periodLabel: string;
  teamName: string | null;
  partName: string | null;
  actorCrewStatus: string | null;
  actorName: string;
  createdAt: string;
};

export default function ExperienceOpeningLogPanel({
  refreshKey,
}: {
  // 값이 바뀌면 재조회(개설/검수 직후 새 행 반영).
  refreshKey?: number;
}) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 파트장 그리드가 선택한 주차(?week) — 있으면 그 주차의 로그를 보여준다(개설 대상 밖 예외 주차 포함).
  //   없으면 서버가 개설 대상 주차로 폴백(기존 동작). 그리드↔로그창 주차 정합 SoT.
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
          `/api/admin/cluster4/experience/opening-logs${suffix ? `?${suffix}` : ""}`,
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
      <CardHeader className="pb-3">
        <CardTitle className="text-base">로그창</CardTitle>
        <CardDescription>
          {weekId
            ? "선택한 주차 라인 개설 행동 이력 (최신순)"
            : "이번 주(개설 대상) 라인 개설 행동 이력 (최신순)"}
        </CardDescription>
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
                  experienceOpeningLogActionClass(l.action),
                )}
              >
                [{EXPERIENCE_OPENING_LOG_ACTION_LABEL[l.action]}]
              </span>{" "}
              [{l.periodLabel}] - {l.teamName ?? "-"} ㅣ {l.partName ?? "-"} ㅣ{" "}
              {l.actorCrewStatus ?? "-"} ㅣ {l.actorName} 님 -{" "}
              {formatLogDateTime(l.createdAt)}
            </p>
          ))
        )}
      </CardContent>
    </Card>
  );
}
