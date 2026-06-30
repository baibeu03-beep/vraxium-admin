// Browser-safe types for the admin "시즌 참여/휴식" 조회 화면.
//
// 조회 전용(read-only). user_season_statuses 를 기준으로 season_definitions /
// user_profiles 를 조합하고, user_week_statuses 를 (user_id, season_key) 로 집계해
// 시즌별 주차 상태 요약을 붙인다. 기존 시즌 휴식 로직은 변경하지 않는다.
//
// user_season_statuses.status 의 실제 허용값(DB CHECK):
//   - 'success' : 시즌 참여(인정, 종료 시즌)
//   - 'active'  : 시즌 참여/활동 (2026-06-26 추가 — 진행 시즌 운영 대상자 멤버십)
//   - 'rest'    : 시즌 휴식
//   - 'stopped' : 시즌 중단 (2026-06-26 추가 — season-scoped, growth_status 미사용)
//   (db/migrations/2026-06-26_user_season_statuses_active.sql
//    CHECK (status IN ('success', 'rest', 'stopped', 'active')))
//
// 요약 카드의 분류(active/rest/stopped/completed/unknown)는 DB 값만으로는 만들 수
// 없으므로 season_definitions 의 기간과 오늘을 함께 써서 파생한다(season_phase):
//   - rest                                   → 'rest'    (휴식)
//   - stopped                                → 'stopped' (중단)
//   - active                                 → 'active'   (참여/활동 — 진행 시즌)
//   - success + 시즌 종료(end_date < 오늘)    → 'completed' (완료)
//   - success + 그 외                         → 'active'   (참여 중)
//   - 그 외                                   → 'unknown'  (기타/미확인)

export const SEASON_PARTICIPATION_STATUSES = ["success", "active", "rest", "stopped"] as const;

export type SeasonParticipationStatus =
  (typeof SEASON_PARTICIPATION_STATUSES)[number];

export function isSeasonParticipationStatus(
  value: unknown,
): value is SeasonParticipationStatus {
  return (
    typeof value === "string" &&
    (SEASON_PARTICIPATION_STATUSES as readonly string[]).includes(value)
  );
}

export type SeasonPhase = "active" | "rest" | "stopped" | "completed" | "unknown";

export type SeasonParticipationRow = {
  // user_season_statuses.id — 단건 상태 수정(PATCH) 대상 식별용.
  user_season_status_id: string;
  user_id: string;
  user_name: string | null;
  organization_slug: string | null;
  season_key: string | null;
  season_label: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
  // user_season_statuses.status 원본('success' | 'rest' | 그 외).
  status: string;
  // 파생 분류(요약/배지용). 위 주석의 규칙으로 계산.
  season_phase: SeasonPhase;
  note: string | null;
  updated_at: string | null;
  // user_week_statuses (user_id, season_key) 집계. 없으면 0.
  total_weeks: number;
  success_weeks: number;
  fail_weeks: number;
  personal_rest_weeks: number;
  official_rest_weeks: number;
};

export type SeasonParticipationSummary = {
  total_count: number;
  active_count: number;
  rest_count: number;
  stopped_count: number;
  completed_count: number;
  unknown_count: number;
};

export type SeasonParticipationSeasonOption = {
  season_key: string;
  season_label: string | null;
};

export type SeasonParticipationFilterOptions = {
  seasonKey?: string | null;
  organizationSlug?: string | null;
  status?: string | null;
  search?: string | null;
  // 운영(operating·기본)/QA(test) 모집단 분기. test=test_user_markers만, operating=실사용자만. 미지정=operating.
  mode?: "operating" | "test";
};

export type SeasonParticipationsDto = {
  rows: SeasonParticipationRow[];
  summary: SeasonParticipationSummary;
  seasons: SeasonParticipationSeasonOption[];
  truncated: boolean;
  generated_at: string;
};

// ─── 단건 상태 수정(PATCH) 전용 DTO ───────────────────────────────────
// 조회 DTO(SeasonParticipationsDto/SeasonParticipationRow)와 분리한다.
//
// 이 PATCH 는 user_season_statuses 단일 row 의 status / note 만 수정한다.
// user_week_statuses(주차 상태) 와 user_growth_stats(성장 캐시) 는 건드리지 않는다.
//   - 시즌 휴식의 "정책" 경로(lib/seasonRestValidation.requestSeasonRest)는
//     deadline 검증 + 1주차 personal_rest 전환 + growth_stats 재집계까지 함께 수행하지만,
//     DB 트리거로 season→week 가 연쇄되지는 않으므로 이 admin UPDATE 와 DB 레벨 충돌은 없다.
//   - 다만 admin 이 status 를 rest/success 로 바꿔도 주차 상태는 자동 동기화되지 않으므로,
//     결과에 week_status_sync_skipped=true 로 그 사실을 명시한다. (요구사항 7/8)

export type SeasonParticipationUpdateInput = {
  // 미지정 필드는 변경하지 않는다(부분 수정). status 는 허용 값(success/rest)만.
  status?: SeasonParticipationStatus;
  note?: string | null;
};

// 수정된 user_season_statuses 단일 row 의 표시값.
export type SeasonParticipationUpdatedRow = {
  user_season_status_id: string;
  user_id: string;
  season_key: string;
  status: string;
  note: string | null;
  updated_at: string | null;
};

export type SeasonParticipationUpdateResult = {
  row: SeasonParticipationUpdatedRow;
  // 항상 true — 이 작업은 user_week_statuses 를 자동 변경하지 않는다.
  week_status_sync_skipped: true;
  // 운영자 안내 문구(주차 상태가 자동 변경되지 않았음을 설명).
  week_status_sync_note: string;
};
