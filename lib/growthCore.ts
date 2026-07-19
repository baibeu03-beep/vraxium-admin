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
  ManualOverrideStatus,
} from "@/shared/growth.contracts";
import { isManualOverrideStatus } from "@/shared/growth.contracts";

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
  organizationReviewStatus?: "aggregating" | "reviewing" | "published" | null;
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
  inconsistency?: "published_without_uws" | null;
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
 * 결정 순서:
 *   0) 공식 휴식 주차(weekIsOfficialRest=seasonCalendar rule ∨ official_rest_periods) →
 *        현재/과거 무관하게 official_rest (개인 휴식보다 우선).
 *   1) 현재 주차(비-공식휴식) → uws=personal_rest 면 personal_rest, 그 외 running.
 *   2) uws 존재(비-현재주, 비-공식휴식) → 기존 표시 로직 보존:
 *        - uws=official_rest(but !weekIsOfficialRest) → published 면 fail, 아니면 tallying
 *        - personal_rest → 그대로
 *        - 성장주차(success/fail) + 미공표 → tallying
 *        - 그 외(공표완료) → uws.status 그대로
 *   3) uws 없음(비-현재주, 비-공식휴식) → 미공표면 tallying, 공표완료면 no_data(null).
 *   4) verdict=fail 이면 (success/fail 한정) fail 로 override + flippedToFail 카운트.
 */
export function resolveWeekResultStatus(
  input: ResolveWeekResultInput,
): ResolveWeekResultOutput {
  const {
    uwsStatus,
    isCurrentWeek,
    isPublished,
    organizationReviewStatus,
    weekIsOfficialRest,
    experienceVerdictStatus,
  } = input;

  let resultStatus: WeekResultStatusKey;

  if (weekIsOfficialRest) {
    // 공식 휴식 주차(seasonCalendar rule ∨ official_rest_periods overlap)는 현재/과거 무관하게
    // 휴식(공식)이다. 이전에는 isCurrentWeek 분기에서만 이 플래그를 봤기 때문에, uws 행이
    // official_rest 로 기록되지 않은 과거 공식 휴식 주차(예: uws 미생성·미공표)가
    // tallying(집계 중)/fail 로 잘못 빠졌다. weekIsOfficialRest 를 모든 주차에 우선 적용한다.
    //   (개인 휴식 신청이 같은 주에 있어도 공식 휴식이 우선 — 기존 현재주 분기와 동일 우선순위.)
    resultStatus = "official_rest";
  } else if (isCurrentWeek) {
    // 현재 주차는 결과 확정 전이므로 항상 진행 중 — 단, 개인 휴식은 휴식으로 표시.
    resultStatus = uwsStatus === "personal_rest" ? "personal_rest" : "running";
  } else if (uwsStatus === "personal_rest") {
    resultStatus = "personal_rest";
  } else if (organizationReviewStatus && organizationReviewStatus !== "published") {
    // 조직 내부 상태(aggregating/reviewing)는 서버·어드민 전용 — 고객 카드에는 노출하지 않는다.
    //   둘 다 기존 'tallying'(성장 집계 중)으로 매핑한다(새 상태/문구/CSS 추가 금지).
    resultStatus = "tallying";
  } else if (uwsStatus !== null) {
    // ── uws 존재(비-현재주, 비-공식휴식): 기존 표시 로직 100% 보존 (과거/직전 카드 불변) ──
    if (uwsStatus === "official_rest") {
      // 공식 휴식으로 기록됐으나 재판정상 활동 주차(!weekIsOfficialRest) → 성장 주차로 간주.
      resultStatus = isPublished ? "fail" : "tallying";
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
      if (organizationReviewStatus === "published") {
        // 공표됐지만 그 사용자 uws 부재 = 데이터 불일치. 카드를 드롭하지 않고 'tallying'(성장 집계 중)으로
        //   유지하고, 호출부(growthResolve)가 서버 로그를 남긴다. 고객에 '검수 중' 노출 금지.
        return { status: "tallying", flippedToFail: false, inconsistency: "published_without_uws" };
      }
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

  return { status: resultStatus, flippedToFail, inconsistency: null };
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
// 성장 상태 10종 판정 (cluster1/3 의 단일 SoT).
//
// 2026-06-07 정책 개정 2단계 — 자동 계산(auto) / 수동 오버라이드(override) 분리:
//   - autoGrowthStatus  = 원천 기록만으로 결정적 계산 (DB growth_status 비참조).
//   - manualOverride    = user_profiles.growth_status ∈ {graduated,suspended,paused}
//                         일 때만 인정 (운영 이벤트 — 자동 도출 불가).
//     legacy 값(seasonal_rest/weekly_rest/graduating/active)은 오버라이드가 아니며
//     표시 계산에서 무시된다(휴식 2종은 신청 기록 uss/uws 에서 자동 도출 —
//     2026-06-07 전수점검에서 DB 값과 양방향 불일치 0건 실측).
//   - displayGrowthStatus = override ?? auto. 고객/관리자/이력서 공통.
//
// 자동 계산 우선순위:
//   seasonal_rest(현재시즌 휴식 신청) → weekly_rest(현재주 personal_rest)
//   → official_rest(현재주 공식휴식) → onboarding(h<=1) → graduating(a>=29)
//   → extra_growth(a>=조직 졸업기준) → active.
//   a = approvedWeeks(성공 주차), h = elapsedWeeks(지나간 주차).
// ─────────────────────────────────────────────────────────────────────

// 졸업 절차 개시 기준: 29주차까지 승인(성공 주차 a)이 완료된 시점.
//   조직별 졸업기준(GRADUATION_THRESHOLDS: encre/phalanx 30, oranke 25)과 별개의
//   고정 상수 — oranke(25)는 25~28 구간에서 extra_growth 가 먼저 표시된다.
//   graduating 은 자동 계산 전용 — 수동 오버라이드 불가(MANUAL_OVERRIDE_STATUSES 제외).
export const GRADUATING_FROM_APPROVED_WEEKS = 29;

// user_profiles.growth_status 원본값 → 수동 오버라이드 3종 추출 (그 외 = null).
export function extractManualOverride(
  growthStatus: string | null,
): ManualOverrideStatus | null {
  return isManualOverrideStatus(growthStatus) ? growthStatus : null;
}

export type ComputeAutoGrowthStatusInput = {
  // 현재 시즌에 시즌 휴식 신청(user_season_statuses.status='rest')이 있는가.
  seasonRestActive: boolean;
  // 현재 시즌에 시즌 중단(user_season_statuses.status='stopped')이 있는가. (2026-summer SoT)
  //   whole-person growth_status 가 아니라 season_key 단위 — 과거 시즌 무영향. 휴식보다 우선.
  seasonStoppedActive?: boolean;
  currentWeekStatus: string | null; // 현재 주차 user_week_statuses.status
  approvedWeeks: number; // a
  elapsedWeeks: number; // h
  graduationThreshold: number | null;
};

// 자동 계산 상태 (DB growth_status 를 전혀 보지 않는다 — 순수·결정적).
export function computeAutoGrowthStatus(
  input: ComputeAutoGrowthStatusInput,
): GrowthStatusKey {
  const {
    seasonRestActive,
    seasonStoppedActive,
    currentWeekStatus,
    approvedWeeks,
    elapsedWeeks,
    graduationThreshold,
  } = input;

  // 시즌 중단(stopped)은 휴식보다 우선 — "성장 중단"(suspended 라벨) 으로 표시.
  if (seasonStoppedActive) return "suspended";
  if (seasonRestActive) return "seasonal_rest";
  if (currentWeekStatus === "personal_rest") return "weekly_rest";
  if (currentWeekStatus === "official_rest") return "official_rest";
  if (elapsedWeeks <= 1) return "onboarding";
  if (approvedWeeks >= GRADUATING_FROM_APPROVED_WEEKS) return "graduating";
  if (graduationThreshold !== null && approvedWeeks >= graduationThreshold)
    return "extra_growth";
  return "active";
}

export type ResolveGrowthStatusInput = ComputeAutoGrowthStatusInput & {
  growthStatus: string | null; // user_profiles.growth_status (오버라이드 후보)
};

export type GrowthStatusResolution = {
  auto: GrowthStatusKey; // 자동 계산 상태
  override: ManualOverrideStatus | null; // 수동 오버라이드 (3종 외 = null)
  display: GrowthStatusKey; // 최종 표시 = override ?? auto
  // 오버라이드가 자동 계산과 다른가 (관리자 경고용 raw 신호 — UI 에서
  // graduated←graduating/extra_growth 정상 졸업 경로는 예외 처리 가능).
  overrideMismatch: boolean;
};

export function resolveGrowthStatusDetail(
  input: ResolveGrowthStatusInput,
): GrowthStatusResolution {
  const auto = computeAutoGrowthStatus(input);
  const override = extractManualOverride(input.growthStatus);
  const display = override ?? auto;
  return {
    auto,
    override,
    display,
    overrideMismatch: override !== null && override !== auto,
  };
}

// 호환 래퍼 — 최종 표시 키만 필요할 때.
export function resolveGrowthStatus(
  input: ResolveGrowthStatusInput,
): GrowthStatusKey {
  return resolveGrowthStatusDetail(input).display;
}
