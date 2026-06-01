// ─────────────────────────────────────────────────────────────────────
// Growth Core — 순수 계산 함수 (browser-safe, DB/서버 import 금지).
//
// Step 2: 주차 결과 6종 판정(resolveWeekResultStatus)을 cluster4WeeklyGrowthData
//         의 인라인 로직에서 1:1 로 추출한 것. 입력만 받아 결정적으로 6종 중
//         하나(또는 no_data=null)를 반환하며, 부수효과/조회가 없다.
//
// ⚠ 동작 불변 원칙: 이 함수의 분기는 cluster4WeeklyGrowthData.ts(구 :662-727)와
//   바이트 단위로 동일한 의미를 가져야 한다. 변경 시 영향도 diff 필수.
// ─────────────────────────────────────────────────────────────────────

import type {
  WeekDbStatusKey,
  WeekResultStatusKey,
  GrowthStatusKey,
} from "@/shared/growth.contracts";

// 실무 경험 필수 슬롯 verdict 상태 (cluster4 ExperienceGrowthVerdictDto.status 와 동일 집합).
export type ExperienceVerdictStatus =
  | "pass"
  | "fail"
  | "pending"
  | "not_applicable";

export type ResolveWeekResultInput = {
  // user_week_statuses.status (없으면 null — weeks 기준 기본 상태로 판정).
  uwsStatus: WeekDbStatusKey | null;
  // 현재(진행 중) 주차인가. isCurrentWeekStart(startDate) 결과.
  isCurrentWeek: boolean;
  // 결과 공표 완료 여부. isWeekPublished(week) 결과.
  isPublished: boolean;
  // 공식 휴식 주차인가(신규 SoT): seasonCalendar rule ∨ official_rest_periods overlap.
  weekIsOfficialRest: boolean;
  // 실무 경험 필수 슬롯 verdict 상태(없으면 null = 미적용).
  experienceVerdictStatus: ExperienceVerdictStatus | null;
};

export type ResolveWeekResultOutput = {
  // 6종 중 하나. null = no_data (카드 미생성 — 기존 `continue` 와 동일).
  status: WeekResultStatusKey | null;
  // DB success → verdict=fail 로 전환되었는가(요약 approved/failed 보정용).
  flippedToFail: boolean;
};

// 주차별 resolved status 1건 (cluster3/cluster4 공유 소비용).
//   no_data(카드 미생성) 주차는 목록에서 제외된다.
//   - 지표 fold: resultStatus + isTransition
//   - 신 h(end_date<today) 판정: endDate
//   - 상태 판정: isCurrentWeek (현재주 official_rest 등)
export type ResolvedWeek = {
  startDate: string;
  endDate: string;
  weekId: string | null;
  resultStatus: WeekResultStatusKey;
  isTransition: boolean;
  isCurrentWeek: boolean;
};

// verdict 가 주차 성장 상태에 fail 로 반영되어야 하는가.
//   lib/lineAvailability.ts 의 shouldApplyExperienceFail 과 동일 규칙(순수 미러).
//   - verdict.status === "fail" 일 때만
//   - 휴식(personal/official_rest)·진행(running)·집계(tallying) 주차는 제외
function appliesExperienceFail(
  verdictStatus: ExperienceVerdictStatus | null,
  baseStatus: WeekResultStatusKey,
): boolean {
  if (verdictStatus !== "fail") return false;
  return baseStatus === "success" || baseStatus === "fail";
}

/**
 * 주차 결과 6종 판정 (순수).
 *
 * 결정 순서 (cluster4WeeklyGrowthData 인라인 로직과 동일):
 *   1) 현재 주차 → 공식휴식이면 official_rest, uws=personal_rest 면 personal_rest, 그 외 running.
 *   2) uws 존재(비-현재주) → 기존 표시 로직 보존:
 *        - official_rest 기록 + 재판정상 활동주차(!weekIsOfficialRest)
 *            → published 면 fail, 아니면 tallying
 *        - personal_rest / official_rest → 그대로
 *        - 성장주차(success/fail) + 미공표 → tallying
 *        - 그 외(공표완료) → uws.status 그대로
 *   3) uws 없음(비-현재주) → 미공표면 tallying, 공표완료면 no_data(null).
 *   4) verdict=fail 이면 (success/fail 한정) fail 로 override + flippedToFail 카운트.
 */
export function resolveWeekResultStatus(
  input: ResolveWeekResultInput,
): ResolveWeekResultOutput {
  const {
    uwsStatus,
    isCurrentWeek,
    isPublished,
    weekIsOfficialRest,
    experienceVerdictStatus,
  } = input;

  let resultStatus: WeekResultStatusKey;

  if (isCurrentWeek) {
    // 현재 주차는 결과 확정 전이므로 항상 진행 중 — 단, 휴식 주차는 휴식으로 표시.
    resultStatus = weekIsOfficialRest
      ? "official_rest"
      : uwsStatus === "personal_rest"
        ? "personal_rest"
        : "running";
  } else if (uwsStatus !== null) {
    // ── uws 존재: 기존 표시 로직 100% 보존 (과거/직전 카드 불변) ──
    if (uwsStatus === "official_rest" && !weekIsOfficialRest) {
      // 공식 휴식으로 기록됐으나 재판정상 활동 주차 → 성장 주차로 간주.
      resultStatus = isPublished ? "fail" : "tallying";
    } else if (uwsStatus === "personal_rest" || uwsStatus === "official_rest") {
      resultStatus = uwsStatus;
    } else if (!isPublished) {
      // 성장 주차(success/fail) + 미공표 → 집계 중.
      resultStatus = "tallying";
    } else {
      resultStatus = uwsStatus;
    }
  } else {
    // ── uws 없음 (비-현재주): weeks 기준 기본 상태 ──
    //   - 미공표 → 집계 중 / 공표완료 → no_data(카드 미생성).
    if (!isPublished) {
      resultStatus = "tallying";
    } else {
      return { status: null, flippedToFail: false };
    }
  }

  // ── 실무 경험 필수 슬롯 verdict 반영 (read-time override) ──
  const baseStatusBeforeVerdict = resultStatus;
  if (appliesExperienceFail(experienceVerdictStatus, resultStatus)) {
    resultStatus = "fail";
  }
  const flippedToFail =
    baseStatusBeforeVerdict === "success" && resultStatus === "fail";

  return { status: resultStatus, flippedToFail };
}

// ─────────────────────────────────────────────────────────────────────
// 성장 지표 (주차 카운트) — cluster4WeeklyGrowthData.computeGrowthSummary 의
// 집계부(구 :202-222)를 1:1 추출. raw user_week_statuses.status 기준 카운트
// (verdict fail 보정은 호출부 getWeeklyGrowth 에서 별도 수행 — 동작 불변).
// ─────────────────────────────────────────────────────────────────────
export type GrowthMetrics = {
  approvedWeeks: number; // success 주차 (전환 제외)
  failedWeeks: number; // fail 주차
  restWeeks: number; // personal_rest 주차
  availableWeeks: number; // approved + failed + rest
  restSeasonCount: number; // user_season_statuses.status='rest' 수 (passthrough)
};

export type FoldGrowthMetricsInput = {
  // 전환 주차 제외는 호출부에서 isTransition 을 미리 계산해 전달(growthCore 는 달력 의존 없음).
  weeks: { status: string; isTransition: boolean }[];
  restSeasonCount: number;
};

export function foldGrowthMetrics(input: FoldGrowthMetricsInput): GrowthMetrics {
  let approvedWeeks = 0;
  let failedWeeks = 0;
  let restWeeks = 0;
  for (const w of input.weeks) {
    if (w.isTransition) continue;
    switch (w.status) {
      case "success":
        approvedWeeks++;
        break;
      case "fail":
        failedWeeks++;
        break;
      case "personal_rest":
        restWeeks++;
        break;
    }
  }
  return {
    approvedWeeks,
    failedWeeks,
    restWeeks,
    availableWeeks: approvedWeeks + failedWeeks + restWeeks,
    restSeasonCount: input.restSeasonCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 종료 상태 (growth_status → 3종 파생). cluster4WeeklyGrowthData 의
// endStatus 결정(구 :238-262)을 1:1 추출.
// ─────────────────────────────────────────────────────────────────────
export type GrowthEndStatus = "completed" | "stopped" | "in_progress";

export function deriveEndStatus(growthStatus: string | null): GrowthEndStatus {
  if (growthStatus === "graduated") return "completed";
  if (growthStatus === "suspended" || growthStatus === "paused") return "stopped";
  return "in_progress";
}

// ─────────────────────────────────────────────────────────────────────
// 성장 상태 10종 판정 (cluster1/3 의 단일 SoT). DB enum(graduated~weekly_rest) 우선,
// 그 외(active/null)는 현재주 official_rest → onboarding(h<=1) → extra_growth(a>=기준) → active.
//   a = approvedWeeks(성공 주차), h = elapsedWeeks(지나간 주차).
// ─────────────────────────────────────────────────────────────────────
export type ResolveGrowthStatusInput = {
  growthStatus: string | null; // user_profiles.growth_status
  currentWeekStatus: string | null; // 현재 주차 user_week_statuses.status
  approvedWeeks: number; // a
  elapsedWeeks: number; // h
  graduationThreshold: number | null;
};

export function resolveGrowthStatus(
  input: ResolveGrowthStatusInput,
): GrowthStatusKey {
  const {
    growthStatus,
    currentWeekStatus,
    approvedWeeks,
    elapsedWeeks,
    graduationThreshold,
  } = input;

  switch (growthStatus) {
    case "graduated":
      return "graduated";
    case "suspended":
      return "suspended";
    case "paused":
      return "paused";
    case "graduating":
      return "graduating";
    case "seasonal_rest":
      return "seasonal_rest";
    case "weekly_rest":
      return "weekly_rest";
  }

  // DB status = active (또는 null) → 계산 상태로 분기
  if (currentWeekStatus === "official_rest") return "official_rest";
  if (elapsedWeeks <= 1) return "onboarding";
  if (graduationThreshold !== null && approvedWeeks >= graduationThreshold)
    return "extra_growth";
  return "active";
}
