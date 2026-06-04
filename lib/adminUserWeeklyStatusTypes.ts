// Browser-safe types for the admin "사용자별 주차 상태" 조회 화면.
//
// 조회 전용(read-only). 기존 계산 로직(user_growth_stats / cluster3 성장 지표 등)은
// 건드리지 않고, 다음 테이블을 user_id 기준으로 조합해 표시값을 만든다:
//   - weeks               : 주차 메타(week_id, week_number, 기간, season_key)
//   - season_definitions  : 시즌 라벨
//   - user_week_statuses  : 주차별 상태(SoT). rows 의 기준 테이블.
//   - user_growth_stats   : 요약 캐시(approved_weeks / cumulative_weeks)
//   - user_weekly_points  : 주차별 별/방패/번개 (points/advantages/penalty)
//   - weekly_reputations  : 주차별 받은 평판(target_user_id 기준)
//   - weekly_colleagues   : 주차별 연계 동료(user_id 기준)
//
// 없는 값은 null 또는 0 으로 안전 처리한다.

export type UserWeeklyStatusValue =
  | "success"
  | "fail"
  | "personal_rest"
  | "official_rest";

export type UserWeeklyStatusRow = {
  user_id: string;
  // 시즌
  season_key: string | null;
  season_label: string | null;
  // 주차 메타. weeks 매칭 실패 시 week_id 는 null, 날짜/번호는 user_week_statuses 값으로 폴백.
  week_id: string | null;
  week_number: number | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  // 상태
  status: string;
  is_success: boolean;
  is_fail: boolean;
  is_personal_rest: boolean;
  is_official_rest: boolean;
  is_official_rest_override: boolean;
  // 전환 주차(시즌 정규 주수 +1). 공식 휴식이 아니며 요약 카운트에서 제외된다.
  is_transition: boolean;
  // 주차별 포인트(user_weekly_points). 없으면 0.
  // 포인트 표시 정책(2026-06-04): 고객 화면 방패 = net(advantage − penalty).
  //   weekly_star_count       = points (check)
  //   weekly_shield_count     = advantages (raw — 내부 전용, 고객 미노출)
  //   weekly_lightning_count  = penalty (원본. 고객 화면에는 −penalty 로 표시)
  //   weekly_net_shield_count = advantages − penalty (고객 화면 표시 방패)
  weekly_star_count: number;
  weekly_shield_count: number;
  weekly_lightning_count: number;
  weekly_net_shield_count: number;
  // 받은 평판(weekly_reputations). 없으면 count=0, score=null.
  weekly_reputation_count: number;
  reputation_score: number | null;
  // 연계 동료(weekly_colleagues). 없으면 0.
  colleague_count: number;
  // 실패 사유 추정값. status='fail' 일 때만 채워지고 그 외엔 null.
  failure_reason: string | null;
};

export type UserWeeklyStatusSummary = {
  total_weeks: number;
  success_weeks: number;
  fail_weeks: number;
  personal_rest_weeks: number;
  official_rest_weeks: number;
  // user_growth_stats 캐시. 행이 없으면 null.
  approved_weeks: number | null;
  cumulative_weeks: number | null;
};

export type UserWeeklyStatusDto = {
  user_id: string;
  summary: UserWeeklyStatusSummary;
  rows: UserWeeklyStatusRow[];
  // 일부 보조 테이블이 미생성/조회 불가일 때 false 로 표기(표시 전용).
  sources: {
    growth_stats: boolean;
    weekly_points: boolean;
    reputations: boolean;
    colleagues: boolean;
  };
  generated_at: string;
};
