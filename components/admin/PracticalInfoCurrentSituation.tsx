"use client";

import { useEffect, useMemo, useState } from "react";
import {
  computeOpenNeed,
  weekName,
  weekRange,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";
import LineOpeningCurrentSituationCard, {
  CurrentSituationWeekValue,
  type CurrentSituationItem,
} from "@/components/admin/LineOpeningCurrentSituationCard";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

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
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && json?.success) setRows((json.data?.rows ?? []) as SeasonWeekRow[]);
        else throw apiErrorFrom(res, json, "주차 정보를 불러오지 못했습니다");
      } catch (err) {
        console.error("[info] season weeks load failed", err);
        if (!cancelled) setError(getApiErrorMessage(err, "주차 정보를 불러오지 못했습니다"));
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

  const items: CurrentSituationItem[] = computed
    ? [
        {
          label: "오늘 날짜",
          helpKey: "admin.lineOpening.currentSituation.info.today",
          value: computed.todayLabel,
        },
        {
          label: "개설 필요 기간",
          helpKey: "admin.lineOpening.currentSituation.info.needPeriod",
          value: computed.need ? (
            <CurrentSituationWeekValue
              label={weekName(computed.need)}
              range={weekRange(computed.need)}
            />
          ) : (
            "-"
          ),
        },
        {
          label: "개설 이행 기간",
          helpKey: "admin.lineOpening.currentSituation.info.fulfilPeriod",
          value: computed.fulfil ? (
            <CurrentSituationWeekValue
              label={weekName(computed.fulfil)}
              range={weekRange(computed.fulfil)}
            />
          ) : (
            "-"
          ),
        },
      ]
    : [];

  return (
    <LineOpeningCurrentSituationCard
      items={items}
      error={error}
      loading={!computed && !error}
      footer={
        computed && !computed.current ? (
          <p className="mt-3 text-sm text-amber-600">
            오늘 날짜가 등록된 주차 범위에 속하지 않습니다. (기간 관리에서 확인)
          </p>
        ) : null
      }
    />
  );
}
