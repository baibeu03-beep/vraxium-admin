-- 2026-05-25_cluster3_growth_indicators.sql
-- Cluster3 성장 지표(Process / Period / Point) 최소 스키마.
--   1) user_profiles: activity_started_at, activity_ended_at 추가
--   2) user_week_statuses: 주차별 성장 상태 (a/b/c/d 계산 핵심)
--   3) user_cumulative_points: total_raw_advantages (k0) 추가
--   4) 기존 30명 더미 데이터 보정
--   5) user_week_statuses 시드
--
-- 의존성: user_profiles, user_cumulative_points, user_growth_stats 존재 가정
-- Idempotent — 이미 적용된 환경에서 다시 실행해도 안전하다.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 스키마 변경
-- ═══════════════════════════════════════════════════════════════════════

-- 1-1. user_profiles: 성장 시작일 / 종료일 --------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS activity_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS activity_ended_at   timestamptz NULL;

COMMENT ON COLUMN public.user_profiles.activity_started_at
  IS '성장 시작일. 항상 월요일 기준. 가입일(created_at)과 분리.';
COMMENT ON COLUMN public.user_profiles.activity_ended_at
  IS '성장 종료일. 졸업/중단 시 확정. active 상태는 NULL.';

-- 1-2. user_week_statuses: 주차별 성장 상태 --------------------------------
CREATE TABLE IF NOT EXISTS public.user_week_statuses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         uuid NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  year            smallint NOT NULL,
  week_number     smallint NOT NULL
                  CHECK (week_number >= 1 AND week_number <= 53),
  week_start_date date NOT NULL,

  status          text NOT NULL
                  CHECK (status IN ('success', 'fail', 'personal_rest', 'official_rest')),

  note            text NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, year, week_number)
);

CREATE INDEX IF NOT EXISTS user_week_statuses_user_id_idx
  ON public.user_week_statuses (user_id);

CREATE INDEX IF NOT EXISTS user_week_statuses_year_week_idx
  ON public.user_week_statuses (year, week_number);

CREATE INDEX IF NOT EXISTS user_week_statuses_status_idx
  ON public.user_week_statuses (user_id, status);

CREATE OR REPLACE FUNCTION public.touch_user_week_statuses_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_week_statuses_set_updated_at
  ON public.user_week_statuses;

CREATE TRIGGER user_week_statuses_set_updated_at
BEFORE UPDATE ON public.user_week_statuses
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_week_statuses_updated_at();

GRANT SELECT ON public.user_week_statuses TO anon, authenticated;

-- 1-2b. user_week_statuses 집계 RPC --------------------------------------
-- Period 계산 시 client-side 에서 전체 row 를 fetch 하지 않고 서버에서 집계.
CREATE OR REPLACE FUNCTION public.get_week_status_counts(p_user_id uuid)
RETURNS TABLE (
  success_count       integer,
  fail_count          integer,
  personal_rest_count integer,
  official_rest_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) FILTER (WHERE status = 'success')::integer       AS success_count,
    COUNT(*) FILTER (WHERE status = 'fail')::integer           AS fail_count,
    COUNT(*) FILTER (WHERE status = 'personal_rest')::integer  AS personal_rest_count,
    COUNT(*) FILTER (WHERE status = 'official_rest')::integer  AS official_rest_count
  FROM public.user_week_statuses
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_week_status_counts(uuid) TO anon, authenticated;

-- 1-3. user_cumulative_points: total_raw_advantages (k0) -----------------
ALTER TABLE public.user_cumulative_points
  ADD COLUMN IF NOT EXISTS total_raw_advantages integer NULL;

COMMENT ON COLUMN public.user_cumulative_points.total_raw_advantages
  IS 'k0: 순수 방패(penalty 차감 전). k = k0 - ABS(total_lightnings).';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 기존 30명 더미 데이터 보정
-- ═══════════════════════════════════════════════════════════════════════

-- 2-1. activity_started_at 역산 -------------------------------------------
-- growth_status 가 active 인 사용자: created_at 에서 직전 월요일로 역산.
-- growth_status 가 graduated/suspended 인 사용자: 동일하게 역산 (종료일은 별도 처리).
-- 이미 값이 있으면 덮어쓰지 않는다.
UPDATE public.user_profiles
SET activity_started_at = (
  created_at::date
  - ((EXTRACT(ISODOW FROM created_at::date)::int - 1) || ' days')::interval
  + '00:00:00+09'::time
)
WHERE activity_started_at IS NULL
  AND growth_status IS NOT NULL;

-- 2-2. activity_ended_at: graduated 사용자만 종료일 설정 --------------------
UPDATE public.user_profiles
SET activity_ended_at = updated_at
WHERE activity_ended_at IS NULL
  AND growth_status = 'graduated';

-- 2-3. total_raw_advantages 역산 ------------------------------------------
-- k0 = total_shields + ABS(total_lightnings)
-- 기존 데이터에서 total_shields 가 이미 k(=k0 - |l|) 라 가정하고 역산한다.
UPDATE public.user_cumulative_points
SET total_raw_advantages = COALESCE(total_shields, 0) + ABS(COALESCE(total_lightnings, 0))
WHERE total_raw_advantages IS NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: user_week_statuses 시드 데이터
-- ═══════════════════════════════════════════════════════════════════════

-- 전략:
--   - activity_started_at 이 있는 사용자에 대해 시작 주차부터 현재까지 주차별 row 생성.
--   - approved_weeks 를 기반으로 success 주차 수를 결정.
--   - 시작 주차부터 순서대로: 일부 official_rest, 나머지 success/fail/personal_rest 배분.
--   - 공식 휴식 주차 (설/추석/연말연시/하계/석가탄신일)
--
-- status 결정 로직:
--   1) 공식 휴식 주차 → 'official_rest'
--   2) 남은 주차 중 approved_weeks 수만큼 앞에서부터 → 'success'
--   3) 마지막에서 두 번째 비공식 주차 1개 → 'personal_rest' (총 3주 이상일 때)
--   4) 나머지 → 'fail'

INSERT INTO public.user_week_statuses (user_id, year, week_number, week_start_date, status)
WITH official_rest AS (
  SELECT year, week_number
  FROM (VALUES
    (2025::smallint,  1::smallint), (2025,  5),       -- 신정, 설
    (2025, 31), (2025, 32),                            -- 하계 휴식
    (2025, 40), (2025, 41),                            -- 추석
    (2025, 52),                                        -- 연말
    (2026,  1), (2026,  5),                            -- 신정, 설
    (2026, 22)                                         -- 석가탄신일
  ) AS v(year, week_number)
),
user_weeks AS (
  SELECT
    up.user_id,
    gs.monday::date AS monday,
    EXTRACT(ISOYEAR FROM gs.monday)::smallint AS iso_year,
    EXTRACT(WEEK FROM gs.monday)::smallint AS iso_week,
    COALESCE(ugs.approved_weeks, 0) AS target_success
  FROM public.user_profiles up
  CROSS JOIN LATERAL generate_series(
    up.activity_started_at::date,
    CURRENT_DATE,
    '7 days'::interval
  ) AS gs(monday)
  LEFT JOIN public.user_growth_stats ugs ON ugs.user_id = up.user_id
  WHERE up.activity_started_at IS NOT NULL
),
classified AS (
  SELECT
    uw.user_id,
    uw.monday,
    uw.iso_year,
    uw.iso_week,
    uw.target_success,
    (orw.week_number IS NOT NULL) AS is_official_rest,
    -- active_seq: 공식 휴식 제외 누적 순번 (1부터)
    CASE WHEN orw.week_number IS NULL
      THEN ROW_NUMBER() OVER (
        PARTITION BY uw.user_id, (orw.week_number IS NULL)
        ORDER BY uw.monday
      )
      ELSE NULL
    END AS active_seq,
    -- total_active: 해당 사용자의 비공식 휴식 주차 총수
    SUM(CASE WHEN orw.week_number IS NULL THEN 1 ELSE 0 END)
      OVER (PARTITION BY uw.user_id) AS total_active
  FROM user_weeks uw
  LEFT JOIN official_rest orw
    ON orw.year = uw.iso_year
   AND orw.week_number = uw.iso_week
)
SELECT
  c.user_id,
  c.iso_year AS year,
  c.iso_week AS week_number,
  c.monday   AS week_start_date,
  CASE
    WHEN c.is_official_rest THEN 'official_rest'
    WHEN c.active_seq <= c.target_success THEN 'success'
    WHEN c.active_seq = c.total_active - 1 AND c.total_active > 3 THEN 'personal_rest'
    ELSE 'fail'
  END AS status
FROM classified c
ON CONFLICT (user_id, year, week_number) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: user_growth_stats 정합성 보정
-- ═══════════════════════════════════════════════════════════════════════

-- approved_weeks = user_week_statuses 에서 success 카운트와 일치하도록 보정.
-- cumulative_weeks = 전체 주차 수 (h) 로 보정.
UPDATE public.user_growth_stats ugs
SET
  approved_weeks = sub.success_count,
  cumulative_weeks = sub.total_count
FROM (
  SELECT
    user_id,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) AS total_count
  FROM public.user_week_statuses
  GROUP BY user_id
) sub
WHERE ugs.user_id = sub.user_id;

-- user_growth_stats 가 아직 없는 사용자에 대해 row 생성.
INSERT INTO public.user_growth_stats (user_id, approved_weeks, cumulative_weeks)
SELECT
  uws.user_id,
  COUNT(*) FILTER (WHERE uws.status = 'success'),
  COUNT(*)
FROM public.user_week_statuses uws
LEFT JOIN public.user_growth_stats ugs ON ugs.user_id = uws.user_id
WHERE ugs.user_id IS NULL
GROUP BY uws.user_id
ON CONFLICT (user_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: 검증 쿼리 (실행만 해서 결과를 확인한다. DML 아님.)
-- ═══════════════════════════════════════════════════════════════════════

-- 5-1. Period 공식 검증: a + b + c + d = h
-- 결과에 mismatch 가 있으면 시드 데이터에 문제가 있는 것.
/*
SELECT
  up.user_id,
  up.display_name,
  up.organization_slug,
  up.activity_started_at,
  up.activity_ended_at,
  COUNT(*) FILTER (WHERE uws.status = 'success')       AS a_success,
  COUNT(*) FILTER (WHERE uws.status = 'fail')           AS b_fail,
  COUNT(*) FILTER (WHERE uws.status = 'personal_rest')  AS c_personal_rest,
  COUNT(*) FILTER (WHERE uws.status = 'official_rest')  AS d_official_rest,
  COUNT(*)                                               AS h_total,
  COUNT(*) FILTER (WHERE uws.status != 'official_rest') AS e_growable,
  ugs.approved_weeks,
  ugs.cumulative_weeks,
  -- 정합성 체크
  CASE WHEN COUNT(*) FILTER (WHERE uws.status = 'success') = COALESCE(ugs.approved_weeks, 0)
       THEN 'OK' ELSE 'MISMATCH' END AS approved_check,
  CASE WHEN COUNT(*) = COALESCE(ugs.cumulative_weeks, 0)
       THEN 'OK' ELSE 'MISMATCH' END AS cumulative_check
FROM public.user_profiles up
LEFT JOIN public.user_week_statuses uws ON uws.user_id = up.user_id
LEFT JOIN public.user_growth_stats  ugs ON ugs.user_id = up.user_id
WHERE up.activity_started_at IS NOT NULL
GROUP BY up.user_id, up.display_name, up.organization_slug,
         up.activity_started_at, up.activity_ended_at,
         ugs.approved_weeks, ugs.cumulative_weeks
ORDER BY up.organization_slug, up.display_name;
*/

-- 5-2. Point 공식 검증: total_shields = total_raw_advantages - ABS(total_lightnings)
/*
SELECT
  up.user_id,
  up.display_name,
  up.organization_slug,
  ucp.total_stars          AS j_points,
  ucp.total_raw_advantages AS k0_raw_advantages,
  ucp.total_lightnings     AS l_penalty,
  ucp.total_shields        AS k_net_advantages_stored,
  ucp.total_raw_advantages - ABS(COALESCE(ucp.total_lightnings, 0))
                           AS k_net_advantages_calc,
  CASE WHEN COALESCE(ucp.total_shields, 0)
          = COALESCE(ucp.total_raw_advantages, 0) - ABS(COALESCE(ucp.total_lightnings, 0))
       THEN 'OK' ELSE 'MISMATCH' END AS point_integrity
FROM public.user_profiles up
LEFT JOIN public.user_cumulative_points ucp ON ucp.user_id = up.user_id
WHERE up.organization_slug IS NOT NULL
ORDER BY up.organization_slug, up.display_name;
*/

-- 5-3. 졸업 가능 주차 판정 (e >= threshold)
/*
SELECT
  up.user_id,
  up.display_name,
  up.organization_slug,
  COUNT(*) FILTER (WHERE uws.status != 'official_rest') AS e_growable,
  CASE up.organization_slug
    WHEN 'encre'   THEN 30
    WHEN 'phalanx' THEN 30
    WHEN 'oranke'  THEN 25
  END AS graduation_threshold,
  CASE WHEN COUNT(*) FILTER (WHERE uws.status != 'official_rest')
         >= CASE up.organization_slug
              WHEN 'encre'   THEN 30
              WHEN 'phalanx' THEN 30
              WHEN 'oranke'  THEN 25
            END
       THEN 'ELIGIBLE' ELSE 'NOT YET' END AS graduation_status
FROM public.user_profiles up
LEFT JOIN public.user_week_statuses uws ON uws.user_id = up.user_id
WHERE up.organization_slug IS NOT NULL
GROUP BY up.user_id, up.display_name, up.organization_slug
ORDER BY up.organization_slug, e_growable DESC;
*/
