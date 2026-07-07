"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import {
  computeOpenNeed,
  weekFull,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";

// 실무 정보 라인 개설 — 상단 "현재 상황" 안내(표시 전용).
//   오늘 날짜/요일 + 개설 필요 기간 + 개설 이행 기간 (금요일 경계, lib/practicalInfoSeasonWeeks).
// ⚠ 저장 강제 주차 정책·snapshot·demoUserId 무관. SoT = /api/admin/season-weeks.

export default function PracticalInfoCurrentSituation() {
  const [rows, setRows] = useState<SeasonWeekRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/season-weeks");
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) setRows((json.data?.rows ?? []) as SeasonWeekRow[]);
        else setError(json?.error ?? "주차 정보를 불러오지 못했습니다");
      } catch {
        if (!cancelled) setError("주차 정보를 불러오지 못했습니다");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const computed = useMemo(
    () => (rows ? computeOpenNeed(rows, new Date()) : null),
    [rows],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">현재 상황</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-base">
        {error ? (
          <p className="text-red-600">{error}</p>
        ) : !computed ? (
          <LoadingState active />
        ) : (
          <>
            <div className="flex gap-3">
              <span className="w-40 shrink-0 whitespace-nowrap text-muted-foreground">오늘 날짜</span>
              <span className="font-semibold">{computed.todayLabel}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-40 shrink-0 whitespace-nowrap text-muted-foreground">개설 필요 기간</span>
              <span className="font-semibold">{weekFull(computed.need)}</span>
            </div>
            <div className="flex gap-3">
              <span className="w-40 shrink-0 whitespace-nowrap text-muted-foreground">개설 이행 기간</span>
              <span className="font-semibold">{weekFull(computed.fulfil)}</span>
            </div>
            {!computed.current && (
              <p className="text-sm text-amber-600">
                오늘 날짜가 등록된 주차 범위에 속하지 않습니다. (/admin/season-weeks 확인)
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
