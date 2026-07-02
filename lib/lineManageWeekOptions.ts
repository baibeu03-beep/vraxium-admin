"use client";

// 라인 관리(조회/관리) 주차 드롭다운 옵션 — 실무 정보/경험/역량 3화면 공용 SoT.
//
// 배경: 실무 정보(PracticalInfoWeekResults)는 /api/admin/season-weeks(전 주차)를 쓰지만,
//   실무 경험/역량 보드는 /api/admin/cluster4/weeks-options?limit=N(최근 N주·최대 6)만 써서
//   드롭다운에 일부 주차만 보였다. "라인 관리"는 조회/관리용이므로 전 주차가 보여야 한다.
//   → 세 화면 모두 이 hook 을 써서 season-weeks 전 주차를 동일 필터로 노출한다.
//
// 주의: 이 hook 은 "드롭다운 목록"만 담당한다. 라인 개설/수정 가능 여부·버튼 활성화 정책은
//   각 화면의 기존 로직(weeks-options 기반)을 그대로 둔다. mode 는 데이터 조회용이며 주차
//   목록엔 영향이 없다(season-weeks 는 mode 무관 — 실무 정보와 동일).

import { useEffect, useMemo, useState } from "react";
import {
  computeOpenNeed,
  isValidLineOpeningWeek,
  seasonLabelOnly,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";

// season-weeks 행(loadSeasonWeeks DTO — is_official_rest 포함).
export type ManageSeasonWeekRow = SeasonWeekRow & {
  week_id: string;
  is_official_rest?: boolean;
};

// 보드 드롭다운 렌더용 옵션(실무 경험/역량 WeekOption 형상과 호환).
export type LineManageWeekOption = {
  id: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string | null;
  endDate: string | null;
  canOpen: boolean; // 표시용(휴식 배지) — 개설 정책 아님.
  isCurrent: boolean;
  isOpenTarget: boolean; // 표시용(개설대상 배지)/기본 선택.
};

// 드롭다운 옵션 필터(실무 정보 PracticalInfoWeekResults 와 동일 기준):
//   미래 주차 제외(개설 필요 주차 이하) · 0주차/전환 주차 등 무효 주차 제외 · 최신순.
//   선택 주차는 필터에 걸려도 항상 포함(controlled <select> value 불일치 방지).
export function buildLineManageWeekRows<T extends SeasonWeekRow>(
  rows: T[],
  selectedWeekId?: string | null,
  now: Date = new Date(),
): T[] {
  const need = computeOpenNeed(rows, now).need;
  const cutoff = need?.week_start_date ?? null;
  const filtered = rows.filter(
    (w) =>
      w.week_id != null &&
      w.week_start_date != null &&
      isValidLineOpeningWeek(w) &&
      (cutoff == null || w.week_start_date <= cutoff),
  );
  if (selectedWeekId && !filtered.some((w) => w.week_id === selectedWeekId)) {
    const sel = rows.find((w) => w.week_id === selectedWeekId);
    if (sel) filtered.push(sel);
  }
  return filtered.sort((a, b) =>
    (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""),
  );
}

function yearOf(row: SeasonWeekRow): number {
  const src = row.week_end_date ?? row.week_start_date;
  return src ? Number(src.slice(0, 4)) : 0;
}

export function toLineManageWeekOption(
  row: ManageSeasonWeekRow,
  needWeekId: string | null,
): LineManageWeekOption {
  return {
    id: row.week_id,
    year: yearOf(row),
    seasonName: seasonLabelOnly(row.season_name),
    weekNumber: row.week_number ?? 0,
    startDate: row.week_start_date ?? null,
    endDate: row.week_end_date ?? null,
    canOpen: row.is_official_rest !== true,
    isCurrent: row.is_current_week === true,
    isOpenTarget: row.week_id === needWeekId,
  };
}

// 라인 관리 주차 드롭다운 hook — season-weeks(전 주차) 단일 SoT.
//   options    : 드롭다운 옵션(최신순, 전 주차)
//   defaultWeekId : 기본 선택(개설대상 → 현재 → 최신). 기존 보드 기본값 로직과 동일.
//   ready/error   : 로딩/오류 상태.
export function useLineManageWeekOptions(): {
  options: LineManageWeekOption[];
  rows: ManageSeasonWeekRow[];
  defaultWeekId: string | null;
  ready: boolean;
  error: string | null;
} {
  const [rows, setRows] = useState<ManageSeasonWeekRow[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/season-weeks", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json?.success) {
          throw new Error(json?.error ?? "주차 정보를 불러오지 못했습니다");
        }
        if (!cancelled) setRows((json.data?.rows ?? []) as ManageSeasonWeekRow[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "주차 정보를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { options, defaultWeekId } = useMemo(() => {
    const need = computeOpenNeed(rows, new Date()).need;
    const needWeekId = need?.week_id ?? null;
    const filtered = buildLineManageWeekRows(rows);
    const opts = filtered.map((r) => toLineManageWeekOption(r, needWeekId));
    const def =
      opts.find((o) => o.isOpenTarget)?.id ??
      opts.find((o) => o.isCurrent)?.id ??
      opts[0]?.id ??
      null;
    return { options: opts, defaultWeekId: def };
  }, [rows]);

  return { options, rows, defaultWeekId, ready, error };
}
