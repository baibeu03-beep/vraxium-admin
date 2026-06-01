// Browser-safe types for the admin "운영 정합성 점검" 화면.
//
// 조회 전용(read-only). 시즌/주차/성장 통계 관련 데이터 정합성 문제를 한 화면에서
// 확인하기 위한 진단 결과 DTO 다. 자동 수정 기능은 포함하지 않는다(조회만).
//
// 점검 항목(요구사항)과 issue_type 매핑:
//   1) user_growth_stats.approved_weeks ≠ uws(status='success') count → growth_approved_mismatch
//   2) user_growth_stats.cumulative_weeks ≠ uws 전체 row count        → growth_cumulative_mismatch
//   3) season status='rest' 인데 해당 시즌 uws 에 personal_rest 전무   → season_rest_without_personal_rest
//   4) season status='success' 인데 해당 시즌 모든 주차가 personal_rest → season_success_all_personal_rest
//   5) weeks.season_key 가 season_definitions 에 없음                   → week_season_key_orphan
//   6) user_week_statuses.season_key 가 season_definitions 에 없음      → uws_season_key_orphan
//   7) uws 가 (year, week_number) 로 weeks(iso_year, iso_week) 매칭 실패 → uws_week_unmapped

export const HEALTH_ISSUE_TYPES = [
  "growth_approved_mismatch",
  "growth_cumulative_mismatch",
  "season_rest_without_personal_rest",
  "season_success_all_personal_rest",
  "week_season_key_orphan",
  "uws_season_key_orphan",
  "uws_week_unmapped",
] as const;

export type HealthIssueType = (typeof HEALTH_ISSUE_TYPES)[number];

export type HealthIssueSeverity = "error" | "warning";

// 요약 카드 4분류. 각 issue_type 이 어느 분류로 집계되는지 고정한다.
export type HealthIssueCategory =
  | "growth_stats"
  | "season_rest"
  | "season_key"
  | "week_mapping";

export type HealthIssueTypeMeta = {
  label: string;
  category: HealthIssueCategory;
  severity: HealthIssueSeverity;
};

// issue_type → (표시 라벨 / 집계 분류 / 기본 심각도). 서버·클라이언트 공용.
export const HEALTH_ISSUE_TYPE_META: Record<HealthIssueType, HealthIssueTypeMeta> =
  {
    growth_approved_mismatch: {
      label: "승인 주차 수 불일치",
      category: "growth_stats",
      severity: "warning",
    },
    growth_cumulative_mismatch: {
      label: "누적 주차 수 불일치",
      category: "growth_stats",
      severity: "warning",
    },
    season_rest_without_personal_rest: {
      label: "시즌 휴식인데 개인 휴식 주차 없음",
      category: "season_rest",
      severity: "warning",
    },
    season_success_all_personal_rest: {
      label: "시즌 참여인데 전 주차 개인 휴식",
      category: "season_rest",
      severity: "warning",
    },
    week_season_key_orphan: {
      label: "주차 시즌 key 미정의",
      category: "season_key",
      severity: "error",
    },
    uws_season_key_orphan: {
      label: "주차 상태 시즌 key 미정의",
      category: "season_key",
      severity: "warning",
    },
    uws_week_unmapped: {
      label: "주차 매핑 실패",
      category: "week_mapping",
      severity: "error",
    },
  };

export type HealthIssue = {
  issue_type: HealthIssueType;
  severity: HealthIssueSeverity;
  user_id: string | null;
  user_name: string | null;
  organization_slug: string | null;
  season_key: string | null;
  week_id: string | null;
  message: string;
  // 기대값/실제값은 표시 전용 문자열(없으면 null).
  expected_value: string | null;
  actual_value: string | null;
};

export type HealthCheckSummary = {
  total_issues: number;
  growth_stats_mismatch_count: number;
  season_rest_mismatch_count: number;
  season_key_mismatch_count: number;
  week_mapping_mismatch_count: number;
};

export type OperationHealthCheckDto = {
  summary: HealthCheckSummary;
  issues: HealthIssue[];
  // issues 가 안전 상한(MAX_ISSUES)을 초과해 잘렸는지 여부.
  // summary 의 카운트는 잘리기 전 전체 기준이다.
  truncated: boolean;
  generated_at: string;
};

// ─── 성장 통계 수동 재집계(POST) 전용 DTO ──────────────────────────────
// 정합성 점검의 "성장 통계 불일치(growth_approved_mismatch/growth_cumulative_mismatch)"
// 만 수동 복구한다. 대상은 user_growth_stats 뿐이며 다른 테이블은 건드리지 않는다.

export type RecalcGrowthStatsMode = "single" | "all_mismatched";

export type RecalcGrowthStatsRequest = {
  mode: RecalcGrowthStatsMode;
  // single 모드에서 필수.
  user_id?: string;
};

export type RecalcGrowthStatsResultItem = {
  user_id: string;
  status: "success" | "error";
  // 성공 시 재집계된 캐시값.
  approved_weeks?: number;
  cumulative_weeks?: number;
  // 실패 시 사유.
  error?: string;
};

export type RecalcGrowthStatsResult = {
  mode: RecalcGrowthStatsMode;
  // 성공적으로 재집계된 사용자 수.
  processed_count: number;
  // 100명 상한 초과로 처리하지 않은 사용자 수.
  skipped_count: number;
  // 재집계 시도 중 실패한 사용자 수.
  failed_count: number;
  // skipped_count > 0(= 상한 초과) 여부.
  truncated: boolean;
  results: RecalcGrowthStatsResultItem[];
};
