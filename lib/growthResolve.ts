// ─────────────────────────────────────────────────────────────────────
// Growth Core — 주차 resolution 레이어 (server-side, 공유).
//
// buildResolvedWeeks: 주차 목록 + 의존 입력(getter) → ResolvedWeek[] (no_data 제외).
//   판정 SoT = growthCore.resolveWeekResultStatus. cluster4 카드 조립이 소비하며,
//   cluster3/cluster1 도 동일 결과를 재사용할 수 있도록 공통 파일로 분리한다(5-B-1).
//
// deps 는 Map 대신 getter 콜백으로 받아 호출부의 행 타입(UwsRow 등)에 결합하지 않는다.
// ─────────────────────────────────────────────────────────────────────

import {
  matchOfficialRestPeriods,
  type OfficialRestPeriodDto,
} from "@/lib/officialRestPeriodsTypes";
import { isSeasonRuleRestForWeekStart } from "@/lib/officialRestPeriodsData";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import {
  resolveWeekResultStatus,
  type ResolvedWeek,
  type ExperienceVerdictStatus,
} from "@/lib/growthCore";
import type { WeekDbStatusKey } from "@/shared/growth.contracts";

const DAY_MS = 86_400_000;
function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type ResolvableWeek = {
  id: string | null;
  start_date: string;
  end_date: string | null;
};

export type BuildResolvedWeeksDeps<W> = {
  // 주차 시작일 → user_week_statuses.status (없으면 null).
  getUwsStatus: (start: string) => string | null;
  // weekId → 실무경험 필수 슬롯 verdict status (없으면 null).
  getVerdictStatus: (weekId: string | null) => ExperienceVerdictStatus | null;
  activeRestPeriods: readonly OfficialRestPeriodDto[];
  isCurrentWeekStart: (start: string) => boolean;
  isWeekPublished: (w: W) => boolean;
};

export function buildResolvedWeeks<W extends ResolvableWeek>(
  weeks: W[],
  deps: BuildResolvedWeeksDeps<W>,
): { byStart: Map<string, ResolvedWeek>; flippedToFail: number } {
  const byStart = new Map<string, ResolvedWeek>();
  let flippedToFail = 0;
  for (const week of weeks) {
    const startDate = week.start_date;
    const weekId = week.id;
    // 종료일: weeks.end_date 우선, 없으면 start+6 (카드 루프와 동일 공식).
    const endDate = week.end_date ?? fmtDate(toMs(startDate) + 6 * DAY_MS);
    // 공식 휴식(신규 SoT): seasonCalendar rule ∨ official_rest_periods overlap.
    const weekIsOfficialRest =
      isSeasonRuleRestForWeekStart(startDate) ||
      matchOfficialRestPeriods({ startDate, endDate }, deps.activeRestPeriods)
        .length > 0;
    const isCurrentWeek = deps.isCurrentWeekStart(startDate);
    const resolved = resolveWeekResultStatus({
      uwsStatus: (deps.getUwsStatus(startDate) ?? null) as WeekDbStatusKey | null,
      isCurrentWeek,
      isPublished: deps.isWeekPublished(week),
      weekIsOfficialRest,
      experienceVerdictStatus: deps.getVerdictStatus(weekId),
    });
    if (resolved.status === null) continue; // no_data → 카드 미생성
    if (resolved.flippedToFail) flippedToFail++;
    byStart.set(startDate, {
      startDate,
      endDate,
      weekId,
      resultStatus: resolved.status,
      isTransition: isTransitionWeekStart(startDate),
      isCurrentWeek,
    });
  }
  return { byStart, flippedToFail };
}
