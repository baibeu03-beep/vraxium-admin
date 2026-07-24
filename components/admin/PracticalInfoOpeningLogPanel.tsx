"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  AdminLogEntity,
  AdminLogEventLabel,
  AdminLogTimestamp,
} from "@/components/admin/AdminLogPresentation";
import OpeningLogScrollContent from "@/components/admin/OpeningLogScrollContent";
import { logChangeKey, orderLogsOldestFirst } from "@/lib/openingLogView";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  formatLogDateTime,
  OPENING_LOG_ACTION_LABEL,
  practicalInfoOpeningLogTone,
  type OpeningLogAction,
} from "@/lib/practicalInfoSection0Format";

// 실무 정보 라인 개설 [섹션 0] 로그창 — 현재 활동유형의 개설/취소 이력(최신순).
// 표시: [개설 여부] 라인명 - 시즌/주차 - 실행한 사람 님 - YY.MM.DD(요일), HH:mm

type LogItem = {
  id: string;
  action: OpeningLogAction;
  activityLabel: string;
  periodLabel: string;
  actorName: string;
  createdAt: string;
};

type Props = {
  activeType: { id: string; name: string } | null;
  // 값이 바뀌면 로그를 재조회한다(개설 직후 새 [개설 완료] 항목 반영).
  refreshKey?: number;
};

export default function PracticalInfoOpeningLogPanel({
  activeType,
  refreshKey,
}: Props) {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const activeTypeId = activeType?.id ?? null;

  const load = useCallback(async () => {
    if (!activeTypeId) {
      setLogs([]);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ activity_type_id: activeTypeId });
      // org 컨텍스트 전달(info=common 이라 결과 동일 — 규약 일관성).
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(`/api/admin/cluster4/opening-logs?${qs.toString()}`);
      const json = await res.json();
      setLogs(json?.success ? (json.data?.logs ?? []) : []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [activeTypeId]);

  useEffect(() => {
    // load 는 activeTypeId 에 의존. refreshKey 변경 시에도 재조회한다(개설 직후 갱신).
    void (async () => {
      await load();
    })();
  }, [load, refreshKey]);

  // 표시 순서: 오래된 로그가 위 · 최신이 아래(서버 최신순 → 표시용으로만 뒤집음).
  const orderedLogs = useMemo(() => orderLogsOldestFirst(logs), [logs]);
  const changeKey = useMemo(() => logChangeKey(logs), [logs]);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-1 text-base">
          로그창
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.section.openingLog"
            title="로그창"
            size="xs"
          />
        </CardTitle>
      </CardHeader>
      <OpeningLogScrollContent
        count={loading ? 0 : logs.length}
        changeKey={changeKey}
      >
        {loading ? (
          <LoadingState active variant="inline" />
        ) : logs.length === 0 ? (
          <p className="text-muted-foreground">
            {activeTypeId
              ? "개설/취소 기록이 없습니다."
              : "활동 유형을 선택해주세요."}
          </p>
        ) : (
          orderedLogs.map((l) => (
            <p key={l.id} className="text-xs leading-relaxed break-words">
              <AdminLogEventLabel tone={practicalInfoOpeningLogTone(l.action)}>
                {OPENING_LOG_ACTION_LABEL[l.action]}
              </AdminLogEventLabel>{" "}
              <AdminLogEntity kind="primary">{l.activityLabel}</AdminLogEntity> -{" "}
              {l.periodLabel} - {l.actorName} 님 -{" "}
              <AdminLogTimestamp>{formatLogDateTime(l.createdAt)}</AdminLogTimestamp>
            </p>
          ))
        )}
      </OpeningLogScrollContent>
    </Card>
  );
}
