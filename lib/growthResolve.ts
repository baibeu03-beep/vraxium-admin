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
  getOrganizationReviewStatus?: (w: W) => "aggregating" | "reviewing" | "published" | null;
  // 현재 시즌이 "시즌 휴식(seasonal_rest)"인 회원의 주차인가(현재 휴식 시즌 한정).
  //   true 면 그 시즌의 활동주차(비공식휴식·비전환)를 휴식(개인)으로 채운다.
  //   미지정 시 false — 비휴식 회원·과거 시즌은 영향 없음(기존 동작 불변).
  isCurrentSeasonRestWeek?: (start: string) => boolean;
  // 그 주차가 "승인된 개인 휴식"(vacation_requests.status='approved')인가.
  //   SoT = lib/approvedRestWeeks.getApprovedRestWeekStarts. true 면 활동주차를 휴식(개인)으로
  //   강제(공식휴식/전환 제외). 시즌 휴식(isCurrentSeasonRestWeek)과 union — 둘 중 하나라도
  //   해당하면 personal_rest. 미지정 시 false(기존 동작 불변).
  isApprovedPersonalRestWeek?: (start: string) => boolean;
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
    //   ⚠ 전환 주차(seasonWeeks+1)도 isSeasonRuleRestForWeekStart 가 true 로 보고한다
    //   (describeWeekByStartMs.isOfficialRest=official_rest∨transition 재사용). 의도적으로
    //   걸러내지 않는다: 전환 주차의 resultStatus 는 isTransition 플래그로 집계·목록·상세에서
    //   모두 별도 처리(전환 주차 라벨)되어 화면값이 마스킹되므로, 여기서 굳이 제외해 과거
    //   uws=official_rest 전환 주차를 fail 로 뒤집는 부작용을 만들지 않는다.
    const weekIsOfficialRest =
      isSeasonRuleRestForWeekStart(startDate) ||
      matchOfficialRestPeriods({ startDate, endDate }, deps.activeRestPeriods)
        .length > 0;
    const isCurrentWeek = deps.isCurrentWeekStart(startDate);
    const resolved = resolveWeekResultStatus({
      uwsStatus: (deps.getUwsStatus(startDate) ?? null) as WeekDbStatusKey | null,
      isCurrentWeek,
      isPublished: deps.isWeekPublished(week),
      organizationReviewStatus: deps.getOrganizationReviewStatus?.(week) ?? null,
      weekIsOfficialRest,
      experienceVerdictStatus: deps.getVerdictStatus(weekId),
    });
    // ── 개인 휴식(휴식 시즌 ∨ 승인된 휴식 주차)의 활동주차 → 휴식(개인) 채움 ──
    //   두 출처의 union:
    //     · isCurrentSeasonRestWeek : 현재 시즌 자체가 시즌 휴식(seasonal_rest)인 회원(기존).
    //     · isApprovedPersonalRestWeek : vacation_requests.status='approved' 주차(신규 SoT).
    //   공식 휴식 주차(official_rest)·전환 주차는 제외(기존 매핑 유지 — 공식 휴식이 개인보다 우선).
    //   no_data(uws 없음)로 사라질 활동주차도 personal_rest 카드로 생성한다(공백 화면 방지).
    //   별도 카드 상태는 만들지 않고 기존 personal_rest 파이프라인(void/게이지0/휴식 배지)을 재사용.
    //   누적 성장주차(success 집계)에는 personal_rest 가 포함되지 않으므로 정책 6 자동 충족.
    let resultStatus = resolved.status;
    const forcePersonalRest =
      ((deps.isCurrentSeasonRestWeek?.(startDate) ?? false) ||
        (deps.isApprovedPersonalRestWeek?.(startDate) ?? false)) &&
      !weekIsOfficialRest &&
      !isTransitionWeekStart(startDate);
    if (forcePersonalRest) {
      resultStatus = "personal_rest";
    }
    if (resolved.inconsistency === "published_without_uws") {
      console.error("[weekly-cards][invariant] organization published but UWS missing", { weekId, startDate });
    }
    if (resultStatus === null) continue; // true no_data only; normal review states remain cards
    if (resolved.flippedToFail) flippedToFail++;
    byStart.set(startDate, {
      startDate,
      endDate,
      weekId,
      resultStatus,
      isTransition: isTransitionWeekStart(startDate),
      isCurrentWeek,
    });
  }
  return { byStart, flippedToFail };
}
