"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) setLoading(true);
      try {
        const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
        const res = await fetch(
          `/api/admin/cluster4/competency/opening-logs${qs}`,
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
  }, [org, refreshKey]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">로그창</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 space-y-1.5 overflow-y-auto text-sm">
        {loading ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
          </p>
        ) : logs.length === 0 ? (
          <p className="text-muted-foreground">
            아직 기록된 개설 로그가 없습니다.
          </p>
        ) : (
          logs.map((l) => (
            <p key={l.id} className="text-[13px] leading-relaxed">
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
