import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import type { ScheduleReliability } from "@/lib/cluster1ResumeTypes";

// ─────────────────────────────────────────────────────────────────────
// 일정 신뢰도 단일 산식(순수 함수 · DB 접근 없음).
//   rate = ((approvedActive + preRest) / (physicalWeeks − officialRest − transition)) × 100
//     a = physicalWeeks(가입 이후 물리적 주차, 시간기반), b = preRest(사전 휴식 신청),
//     c = unapprovedActive(미인정 활동), d = approvedActive(인정 활동), e = officialRest(공식 휴식).
//   전환 주차(isTransitionWeekStart)는 분자·분모 모두에서 제외(공식 휴식 아님 — 분모 보정만).
//
// computeScheduleReliability(단건·resume)·getScheduleReliabilityRateBatch(roster)·
// writeRosterCardStats(slim writer) 세 호출부가 이 코어 하나만 쓰도록 통일해 drift 를 차단한다.
//   activity_started_at 부재/무효 → null(산정 불가). 호출부가 단건=dummy, 배치/slim=NULL 로 매핑.
// ─────────────────────────────────────────────────────────────────────

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

export type ScheduleWeekRow = { week_start_date: string | null; status: string };

export function computeScheduleReliabilityFromRows(
  activityStart: string | null,
  rows: ScheduleWeekRow[],
  nowMs: number,
): ScheduleReliability | null {
  if (!activityStart) return null;
  const startMs = new Date(activityStart).getTime();
  if (Number.isNaN(startMs)) return null;

  const physicalWeeks = Math.max(1, Math.floor((nowMs - startMs) / MS_PER_WEEK));

  let preRestWeeks = 0;
  let unapprovedActiveWeeks = 0;
  let approvedActiveWeeks = 0;
  let officialRestWeeks = 0;
  let transitionWeeks = 0;

  for (const row of rows) {
    if (row.week_start_date && isTransitionWeekStart(row.week_start_date)) {
      transitionWeeks++;
      continue;
    }
    switch (row.status) {
      case "success":
        approvedActiveWeeks++;
        break;
      case "fail":
        unapprovedActiveWeeks++;
        break;
      case "personal_rest":
        preRestWeeks++;
        break;
      case "official_rest":
        officialRestWeeks++;
        break;
    }
  }

  const denominator = physicalWeeks - officialRestWeeks - transitionWeeks;
  const rate =
    denominator > 0
      ? Math.round(((approvedActiveWeeks + preRestWeeks) / denominator) * 100)
      : 0;

  return {
    physicalWeeks,
    preRestWeeks,
    unapprovedActiveWeeks,
    approvedActiveWeeks,
    officialRestWeeks,
    rate,
  };
}
