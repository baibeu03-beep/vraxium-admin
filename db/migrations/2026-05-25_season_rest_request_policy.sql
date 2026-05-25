-- 2026-05-25_season_rest_request_policy.sql
-- Case 3: 시즌 전체 휴식 신청 시점 제약 + 1주차 비활동 처리.
--   1) user_season_statuses.requested_at 컬럼 추가
--   2) validate_season_rest_request(user_id, season_key) 검증 함수
--   3) 기존 더미 데이터 보정 (requested_at + 1주차 전환)
--
-- 정책:
--   - 시즌 시작 후 1주차까지만(start_date + 7일) 시즌 전체 휴식 신청 가능
--   - 신청 시 해당 시즌 1주차는 활동 비인정 → personal_rest 로 전환
--   - 2주차 이후에는 시즌 휴식 불가 (중도 중단 또는 남은 주차 개인 휴식 전환)
--   - 1주차 비활동 처리는 user_week_statuses.status = 'personal_rest' 로 기록
--     (별도 status 추가 없음 — 시즌 휴식 여부는 user_season_statuses 에서 추적)
--
-- 의존성: user_season_statuses, season_definitions, user_week_statuses
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: user_season_statuses.requested_at
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_season_statuses
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NULL;

COMMENT ON COLUMN public.user_season_statuses.requested_at
  IS '시즌 전체 휴식 신청 시각. status=rest 인 경우에만 의미 있음. 시즌 시작 후 7일 이내여야 유효.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 검증 함수
-- ═══════════════════════════════════════════════════════════════════════
-- 시즌 전체 휴식 신청 가능 여부를 판정하는 함수.
-- Admin API 에서 시즌 휴식 상태 변경 전에 호출.
--
-- 반환:
--   'ok'                   → 신청 가능
--   'deadline_passed'      → 시즌 시작 후 1주 초과
--   'season_not_found'     → season_key 무효
--   'already_rest'         → 이미 rest 상태
--   'season_not_started'   → 시즌 미시작 (허용 — 사전 신청 가능)

CREATE OR REPLACE FUNCTION public.validate_season_rest_request(
  p_user_id uuid,
  p_season_key text,
  p_request_time timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_start_date date;
  v_deadline date;
  v_existing_status text;
BEGIN
  -- 시즌 존재 확인
  SELECT start_date INTO v_start_date
  FROM public.season_definitions
  WHERE season_key = p_season_key;

  IF v_start_date IS NULL THEN
    RETURN 'season_not_found';
  END IF;

  -- 기존 상태 확인
  SELECT status INTO v_existing_status
  FROM public.user_season_statuses
  WHERE user_id = p_user_id AND season_key = p_season_key;

  IF v_existing_status = 'rest' THEN
    RETURN 'already_rest';
  END IF;

  -- 데드라인 = 시즌 시작일 + 7일
  v_deadline := v_start_date + 7;

  IF p_request_time::date > v_deadline THEN
    RETURN 'deadline_passed';
  END IF;

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_season_rest_request(uuid, text, timestamptz)
  TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 더미 데이터 보정
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1. 모든 rest 시즌에 requested_at 설정 (시즌 시작일 + 3일 = 1주차 이내)
UPDATE public.user_season_statuses uss
SET requested_at = (sd.start_date + 3)::date::timestamptz,
    note = '시즌 전체 휴식 신청 (시즌 시작 3일 후)'
FROM public.season_definitions sd
WHERE uss.season_key = sd.season_key
  AND uss.status = 'rest'
  AND uss.requested_at IS NULL;

-- 3-2. rest 시즌의 1주차 → personal_rest 전환
-- 해당 사용자의 해당 시즌 첫 번째 주차를 personal_rest 로 변경.
-- (시즌 전체 휴식 시 1주차는 활동 비인정)
UPDATE public.user_week_statuses uws
SET status = 'personal_rest',
    note = '시즌 전체 휴식으로 인한 1주차 비활동 처리'
WHERE uws.id IN (
  SELECT DISTINCT ON (uws2.user_id, uss.season_key) uws2.id
  FROM public.user_season_statuses uss
  JOIN public.user_week_statuses uws2
    ON uws2.user_id = uss.user_id
   AND uws2.season_key = uss.season_key
  WHERE uss.status = 'rest'
  ORDER BY uws2.user_id, uss.season_key, uws2.week_start_date
);

-- 3-3. growth_stats 재집계 (1주차 전환으로 a 변동)
UPDATE public.user_growth_stats ugs
SET approved_weeks = sub.success_count,
    cumulative_weeks = sub.total_count
FROM (
  SELECT
    user_id,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) AS total_count
  FROM public.user_week_statuses
  GROUP BY user_id
) sub
WHERE ugs.user_id = sub.user_id
  AND (ugs.approved_weeks != sub.success_count
    OR ugs.cumulative_weeks != sub.total_count);

-- 3-4. points 재계산 (영향 받는 사용자만)
-- rest 시즌 보유 사용자의 point 보정
UPDATE public.user_cumulative_points ucp
SET total_stars = sub.a * 3,
    total_raw_advantages = sub.a * 2 + 3,
    total_shields = (sub.a * 2 + 3) - ABS(COALESCE(ucp.total_lightnings, 0))
FROM (
  SELECT
    uws.user_id,
    COUNT(*) FILTER (WHERE uws.status = 'success') AS a
  FROM public.user_week_statuses uws
  WHERE uws.user_id IN (
    SELECT DISTINCT user_id FROM public.user_season_statuses WHERE status = 'rest'
  )
  GROUP BY uws.user_id
) sub
WHERE ucp.user_id = sub.user_id;
