// Browser-safe types for the admin "주차 인정 결과" 조회 화면.
//
// 조회 전용(read-only). user_week_statuses 를 기준으로 weeks / season_definitions /
// user_profiles 를 조합해 "특정 주차 또는 시즌 기준 사용자별 주차 인정 상태" 목록을
// 만든다. 기존 계산 로직은 변경하지 않는다.

export const WEEK_RECOGNITION_STATUSES = [
  "success",
  "fail",
  "personal_rest",
  "official_rest",
] as const;

export type WeekRecognitionStatus = (typeof WEEK_RECOGNITION_STATUSES)[number];

export function isWeekRecognitionStatus(
  value: unknown,
): value is WeekRecognitionStatus {
  return (
    typeof value === "string" &&
    (WEEK_RECOGNITION_STATUSES as readonly string[]).includes(value)
  );
}

export type WeekRecognitionRow = {
  // user_week_statuses.id — 단건 상태 수정(PATCH) 대상 식별용.
  user_week_status_id: string;
  user_id: string;
  user_name: string | null;
  organization_slug: string | null;
  season_key: string | null;
  season_label: string | null;
  week_id: string | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  status: string;
  is_official_rest_override: boolean;
  note: string | null;
  updated_at: string | null;
  // 이 주차(week_id)의 집계/공표 완료 시점(weeks.result_published_at).
  //   NULL  = 미공표 → 고객 카드 "성장(집계 중)"(tallying).
  //   값 존재 = 공표 완료 → success/fail 노출. 주차 단위 전역 값이라 같은 week_id 행은 동일.
  week_result_published_at: string | null;
};

export type WeekRecognitionSummary = {
  total_count: number;
  success_count: number;
  fail_count: number;
  personal_rest_count: number;
  official_rest_count: number;
};

// 화면 필터(시즌/주차) 드롭다운 구성을 위한 보조 옵션.
export type WeekRecognitionSeasonOption = {
  season_key: string;
  season_label: string | null;
};

export type WeekRecognitionWeekOption = {
  week_id: string;
  season_key: string | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  // weeks.result_published_at — 주차 선택 시 공표 상태/버튼 표시에 사용.
  result_published_at: string | null;
};

export type WeekRecognitionFilterOptions = {
  seasonKey?: string | null;
  weekId?: string | null;
  organizationSlug?: string | null;
  status?: string | null;
  search?: string | null;
};

export type WeekRecognitionsDto = {
  rows: WeekRecognitionRow[];
  summary: WeekRecognitionSummary;
  seasons: WeekRecognitionSeasonOption[];
  weeks: WeekRecognitionWeekOption[];
  // 안전 상한(MAX_ROWS) 초과로 일부 행이 잘렸는지 여부.
  truncated: boolean;
  generated_at: string;
};

// ─── 단건 상태 수정(PATCH) 전용 DTO ───────────────────────────────────
// 조회 DTO(WeekRecognitionsDto/WeekRecognitionRow)와 분리한다.

export type WeekRecognitionUpdateInput = {
  // 미지정 필드는 변경하지 않는다(부분 수정). status 는 허용 값만.
  status?: WeekRecognitionStatus;
  note?: string | null;
  is_official_rest_override?: boolean;
};

// 수정된 user_week_statuses 단일 row 의 표시값.
export type WeekRecognitionUpdatedRow = {
  user_week_status_id: string;
  user_id: string;
  year: number | null;
  week_number: number | null;
  week_start_date: string | null;
  status: string;
  is_official_rest_override: boolean;
  note: string | null;
  updated_at: string | null;
};

// 재집계된 user_growth_stats 캐시값.
export type WeekRecognitionGrowthStats = {
  approved_weeks: number;
  cumulative_weeks: number;
};

export type WeekRecognitionUpdateResult = {
  row: WeekRecognitionUpdatedRow;
  // user_growth_stats(approved_weeks/cumulative_weeks) 재집계를 건너뛰었는지 여부.
  //   false = 정상 동기화됨, true = 동기화 안 됨(실패 등 — recalculation_note 참조).
  recalculation_skipped: boolean;
  // 재집계 결과/사유 설명(운영자 안내용).
  recalculation_note: string;
  // 재집계 성공 시 갱신된 캐시값. 실패/건너뜀이면 null.
  growth_stats: WeekRecognitionGrowthStats | null;
};

// ─── 주차 결과 공표(publish) 전용 DTO ─────────────────────────────────
// weeks.result_published_at 을 now() 로 세팅하는 액션 결과. user_week_statuses 는 건드리지 않는다.

export type WeekResultPublishResult = {
  week_id: string;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  result_published_at: string;
  // 공표 직후 해당 주차 참여자 snapshot 재계산 결과(쓰기 시점 갱신). best-effort —
  // 실패해도 공표는 유지되며, 이 필드는 운영 안내용(optional, append-only).
  snapshot_recompute?: {
    requested: number;
    recomputed: number;
    failed: number;
  };
};
