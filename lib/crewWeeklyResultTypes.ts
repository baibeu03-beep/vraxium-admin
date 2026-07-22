// 주차 결과(크루) — DTO 타입 + 순수 판정/표기 함수 (**브라우저 안전**).
//
// 서버 로더(lib/crewWeeklyResultProjection)는 supabaseAdmin 을 import 하므로 클라이언트가
//   그 모듈에서 값을 가져오면 서버 그래프가 클라이언트 번들로 끌려온다(node:async_hooks 등).
//   → "타입 + 순수 함수"는 이 파일에 두고, 화면 컴포넌트는 여기서만 값을 가져온다.
//   (lib/weekOpenGate 와 동일한 분리 규칙.)
//
// ⚠ 이 파일에는 DB 접근도, 현재 시각 접근도 없다. 상태 판정에 필요한 "사실"은 전부 인자로 받는다 —
//   그래야 서버·검증 스크립트·시간 주입 테스트가 완전히 같은 함수를 쓸 수 있다.

import type { OrganizationSlug } from "@/lib/organizations";
import type { OrgResultScope, WeekOrgResultStatus } from "@/lib/weekOrgResultState";

// ── 활동 유형 ────────────────────────────────────────────────────────────────
export type CrewWeeklyActivityKind = "official_activity" | "official_rest";

export const CREW_WEEKLY_ACTIVITY_LABEL: Record<CrewWeeklyActivityKind, string> = {
  official_activity: "공식 활동",
  official_rest: "공식 휴식",
};

// ── 상태 ─────────────────────────────────────────────────────────────────────
// 내부 lifecycle — 실제 업무 단계를 손실 없이 보존한다. 앞으로 "집계 실패"·"공표 완료" 등을
//   구분해야 할 때 DTO 구조를 뒤엎지 않도록 표시 상태와 분리해 둔다.
export type CrewWeeklyResultLifecycleStatus =
  | "scheduled" // 아직 시작하지 않은 미래 주차. **결과 화면에 노출하지 않는다.**
  | "activity_in_progress" // 활동 입력 기간(시작됨 · 주차 종료 전). 아직 집계 단계 아님.
  | "aggregation_pending" // 입력 종료 · 아직 결과 공표 전(자동 집계 대기).
  | "aggregation_in_progress" // 조직 상태 reviewing — 검수/확정 파이프라인 실행 중.
  | "review_pending" // 결과는 공표됐으나 이 조직의 검수 완료가 아직 아님.
  | "review_completed"; // 조직 상태 published — 확정.

// 화면 표시 상태(3종). lifecycle 을 압축한 것일 뿐 별도 계산이 아니다.
export type CrewWeeklyResultDisplayStatus = "in_progress" | "aggregating" | "completed";

export const CREW_WEEKLY_DISPLAY_STATUS_LABEL: Record<
  CrewWeeklyResultDisplayStatus,
  string
> = {
  in_progress: "진행 중",
  aggregating: "집계 중",
  completed: "검수 완료",
};

export function toCrewWeeklyDisplayStatus(
  status: CrewWeeklyResultLifecycleStatus,
): CrewWeeklyResultDisplayStatus {
  switch (status) {
    // scheduled 는 목록/상세에서 필터로 제외되므로 정상 경로에서는 도달하지 않는다.
    //   방어적으로 "진행 중"이 아니라 "집계 중"으로도 승격시키지 않고 in_progress 를 반환하되,
    //   ⚠ 노출 차단의 책임은 로더 필터(isFutureWeek)에 있다 — 여기서 미래 주차를 진행 중처럼
    //   보이게 만들지 않도록, 호출부는 반드시 scheduled 를 먼저 걸러야 한다.
    case "scheduled":
    case "activity_in_progress":
      return "in_progress";
    case "aggregation_pending":
    case "aggregation_in_progress":
    case "review_pending":
      return "aggregating";
    case "review_completed":
      return "completed";
  }
}

// ── 순수 판정 함수 ───────────────────────────────────────────────────────────
export type CrewWeeklyLifecycleInput = {
  /** 조직별 검수 상태 SoT(cluster4_week_org_result_states). 폴백 포함 resolve 된 값. */
  orgStatus: WeekOrgResultStatus;
  /** 활동 기준일 < 주차 시작일 — 아직 시작하지 않은 미래 주차. */
  notStarted: boolean;
  /** 활동 기준일이 주차 마지막 날 이상 — 이 시점부터 활동 입력이 아니라 집계 단계다. */
  aggregationWindowOpen: boolean;
  /** 활동 기준일이 주차 마지막 날을 지남(= 주차 종료). */
  weekEnded: boolean;
  /** weeks.result_published_at != null — 주차 전역 결과 공표(조직 검수와 별개). */
  globallyPublished: boolean;
};

export function resolveCrewWeeklyLifecycle(
  input: CrewWeeklyLifecycleInput,
): CrewWeeklyResultLifecycleStatus {
  // 0) 미래 주차 방어 — 아직 시작도 안 한 주차를 "진행 중"으로 해석하는 경로를 원천 차단한다.
  //    (검수 상태가 어떻든 시작 전이면 결과가 존재할 수 없다. 노출 자체는 로더가 필터한다.)
  if (input.notStarted) return "scheduled";
  // 1) 데이터 우선 — 조직이 검수 완료(published)했다면 날짜와 무관하게 확정이다.
  if (input.orgStatus === "published") return "review_completed";
  // 2) 검수 파이프라인이 실행 중(reviewing)이면 집계 단계다(주차가 아직 안 끝났어도 동일).
  if (input.orgStatus === "reviewing") return "aggregation_in_progress";
  // 3) 아직 집계 창이 열리지 않았다 = 활동 입력 기간.
  //    ⚠ 미래 주차도 여기로 온다(아직 집계 단계가 아니라는 사실은 동일). 표시=진행 중.
  if (!input.aggregationWindowOpen) return "activity_in_progress";
  // 4) 집계 창이 열렸는데 조직 상태가 aggregating —
  //    결과가 전역 공표됐다면 "검수 대기", 아니면 "집계 대기". 둘 다 표시상 집계 중이다.
  //    ⚠ weekEnded 만으로 완료 승격하지 않는다(집계 실패/검수 누락을 완료로 위장하지 않기 위함).
  void input.weekEnded;
  return input.globallyPublished ? "review_pending" : "aggregation_pending";
}

// ── DTO ──────────────────────────────────────────────────────────────────────
export type CrewWeeklyResultOrganizationDto = {
  /** 불변 식별자 = 조직 slug. URL·API·비교는 항상 이 값을 쓴다. */
  organizationId: OrganizationSlug;
  organizationSlug: OrganizationSlug;
  /** 표시 전용 한글명(organizationLabelKo). 식별자로 쓰지 않는다. */
  organizationName: string;
};

export type CrewWeeklyResultWeekDto = {
  weekId: string;
  seasonKey: string | null;
  seasonName: string | null;
  weekNumber: number | null;
  /** "26년 여름 시즌 4주차" — weekBannerName SoT. */
  displayName: string;
  /** "26 - 여름 - 4" — weekTableName SoT(활동 관리 화면과 동일 표기). */
  tableName: string;
  startDate: string | null;
  endDate: string | null;
  /** "26 - 07 - 20 (월) ~ 26 - 07 - 26 (일)" — weekRangeLabel SoT(클럽 날짜 표기). */
  periodLabel: string;
  /** 주차 전역 활동 유형. 조직별로 갈리지 않는다. */
  activityKind: CrewWeeklyActivityKind;
  activityKindLabel: string;
  isCurrentWeek: boolean;
};

export type CrewWeeklyResultCellDto = {
  organizationId: OrganizationSlug;
  organizationSlug: OrganizationSlug;
  organizationName: string;

  weekId: string;

  /** 주차 DTO 와 동일 값(셀 단독 렌더용 미러). 원천은 하나다. */
  activityKind: CrewWeeklyActivityKind;
  activityKindLabel: string;

  /** 내부 단계(손실 없는 원본). 파리티 비교는 이 값으로 한다. */
  lifecycleStatus: CrewWeeklyResultLifecycleStatus;
  /** 화면 3종 표시 상태. 클라이언트가 시각으로 재계산하지 않는다. */
  displayStatus: CrewWeeklyResultDisplayStatus;
  displayStatusLabel: string;

  /** 조직별 검수 상태 원본(cluster4_week_org_result_states) — 디버깅/파리티용. */
  reviewStatus: WeekOrgResultStatus;
  /** organization = 조직별 행 존재 · legacy = 행 없음(weeks.result_reviewed_at 폴백). */
  reviewStatusSource: "organization" | "legacy";

  /** cluster4_week_opening_configs.open_confirmed — 고객 앱 활동 가능 게이트(읽기 전용). */
  openConfirmed: boolean;

  /** 관리자가 조직별 검수를 실행해 확정됨(레거시 날짜 폴백이 아님). */
  isManuallyCompleted: boolean;
  /** 조직별 검수 완료 시각(cluster4_week_org_result_states.published_at). */
  completedAt: string | null;
  /** 주차 전역 공표 시각(weeks.result_published_at). */
  publishedAt: string | null;
  /**
   * 확정 버전 — 현재 (주차 × 조직) 결과에 대한 버전 SoT 가 존재하지 않는다(주차 카드
   *   snapshot 의 dto_version 은 캐시 스키마 버전이지 결과 버전이 아니다). 필드를 미리 열어두되
   *   값은 만들지 않는다(null 고정). 재집계 버전 도입 시 여기에 실제 SoT 를 연결한다.
   */
  resultVersion: number | null;

  /** 수동 검수 완료 버튼 노출 가능 여부(실제 처리는 다음 단계). */
  canCompleteManually: boolean;

  // ── 기준 포인트 A ──────────────────────────────────────────────────────────
  /**
   * 그 주차 성장 성공 판정에 **실제 적용된** 기준 포인트 A.
   *   SoT = cluster4_week_opening_configs.recognition_count_n[week_id, organization_slug]
   *   (2026-07-12 정책 전환: 종전 org_week_thresholds→weeks.check_threshold→30 체인은 verdict 에서 제거).
   *   판정식 = user_weekly_points.points(earned) >= recognition_count_n(required).
   *   오픈 확인 시점에 A(min_points_a)·B(exec_points_b)와 함께 확정 저장되므로 과거 주차도 그때 값 그대로다.
   *   ⚠ 값이 없으면(미오픈확인/미적용 주차) **null**. 기본값 30 폴백 금지 — lineAvailability 가
   *     hasRequired=false → enforced=false 로 다루는 것과 동일 의미(기준값 없음 ≠ 30).
   */
  criterionPointA: number | null;
  /** N 산출 근거 A(최소자 총합). 재현/감사용 — 없으면 null. */
  criterionMinPointsA: number | null;
  /** N 산출 근거 B(성실자 총합). 재현/감사용 — 없으면 null. */
  criterionExecPointsB: number | null;

  // ── 크루 종합 지표(고객 앱 /weekly-ranking "이번 주 크루 종합 결과"와 동일 규칙) ──
  //   산출 = lib/crewWeeklyMetricsAggregation(front aggregateWeeklyLeague memberRosterMode 1:1 이식).
  //   ⚠ 비율은 **0~100 정수 퍼센트**다(필드명 ...RatePercent 로 단위 고정 — 0~1 아님).
  //   ⚠ null = 미확정 마스킹(화면 "N"). 0(실제 0명)과 반드시 구분한다.
  //     검수 완료(review_completed) 주차에서만 숫자가 채워진다 — 고객 앱 isTallying 규칙과 동일.
  memberCount: number | null;
  seasonRestCount: number | null;
  personalRestCount: number | null;
  growthChallengeCount: number | null;
  growthSuccessCount: number | null;
  growthFailureCount: number | null;
  growthSuccessRatePercent: number | null;
  growthChallengeRatePercent: number | null;
  /** 결과 지표를 표시해도 되는가(= 검수 완료 + 공표 snapshot 보유). false 면 위 값은 전부 null. */
  metricsAvailable: boolean;
  /** 표시값의 출처가 된 활성 finalize run id(공표 snapshot). 미공표/legacy 면 null. */
  publishedRunId: string | null;
  /** @deprecated 자리 예약 — 사용하지 않는다. */
  publishedAt2: null;
  /** 확정 aggregate override(weekly_league_success_overrides) 가 적용된 값인가. */
  metricsFromAdminOverride: boolean;
};

export type CrewWeeklyResultsPagination = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type CrewWeeklyResultsBundleDto = {
  /** 조회 스코프 — 통합이면 허용 조직 전체, 클럽 상세면 1개. */
  organizations: CrewWeeklyResultOrganizationDto[];
  /** 행(주차) — 최신 주차 최상단. */
  weeks: CrewWeeklyResultWeekDto[];
  /** 셀 — weeks × organizations. key = crewWeeklyCellKey(weekId, org). */
  cells: CrewWeeklyResultCellDto[];
  pagination: CrewWeeklyResultsPagination;
  /** 판정에 사용한 활동 기준일(00:01 KST). 클라이언트 재계산 금지 근거. */
  activityDate: string;
  /**
   * 검수 상태 **및 모든 지표**가 공유하는 단일 scope(operating/test).
   *   resolveOrgResultScope(mode) 한 곳에서 나오며, lifecycle 과 metrics 가 반드시 같은 값을 쓴다.
   *   ⚠ 한 행 안에서 상태와 지표의 모집단이 갈리면 안 된다(2026-07-22 버그 재발 방지).
   */
  scope: OrgResultScope;
  /** 지표 모집단(로스터) 크기 — scope 검증용. 조직별 합계. */
  populationSize: number;
};

export const CREW_WEEKLY_RESULTS_DEFAULT_PAGE_SIZE = 20;
export const CREW_WEEKLY_RESULTS_MAX_PAGE_SIZE = 100;

/** 셀 조회 키 — 목록/상세가 동일 규칙으로 셀을 찾는다. */
export function crewWeeklyCellKey(weekId: string, org: OrganizationSlug): string {
  return `${weekId}:${org}`;
}
