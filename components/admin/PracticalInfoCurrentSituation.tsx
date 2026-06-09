"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
        <CardTitle className="text-base">현재 상황</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {error ? (
          <p className="text-red-600">{error}</p>
        ) : !computed ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
          </p>
        ) : (
          <>
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">오늘 날짜</span>
              <span className="font-semibold">{computed.todayLabel}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">개설 필요 기간</span>
              <span className="font-semibold">{weekFull(computed.need)}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">개설 이행 기간</span>
              <span className="font-semibold">{weekFull(computed.fulfil)}</span>
            </div>
            {!computed.current && (
              <p className="text-xs text-amber-600">
                오늘 날짜가 등록된 주차 범위에 속하지 않습니다. (/admin/season-weeks 확인)
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
