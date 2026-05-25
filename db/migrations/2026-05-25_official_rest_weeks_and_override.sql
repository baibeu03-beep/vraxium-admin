-- 2026-05-25_official_rest_weeks_and_override.sql
-- Case 1: 공식 휴식 주차 정의 + 활동 인정 예외 추적.
--   1) official_rest_weeks: 시스템 차원 공식 휴식 주차 정의
--   2) user_week_statuses.is_official_rest_override: 공식 휴식이지만 활동 인정된 주차
--   3) 기존 데이터 보정 + override 샘플 생성
--
-- 의존성: user_week_statuses 존재 가정
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: official_rest_weeks 테이블
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.official_rest_weeks (
  id          smallserial PRIMARY KEY,
  year        smallint NOT NULL,
  week_number smallint NOT NULL
              CHECK (week_number >= 1 AND week_number <= 53),
  reason      text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, week_number)
);

CREATE INDEX IF NOT EXISTS official_rest_weeks_year_week_idx
  ON public.official_rest_weeks (year, week_number);

GRANT SELECT ON public.official_rest_weeks TO anon, authenticated;

-- official_rest_weeks는 명절 공식 휴식(설/구정, 추석)만 보관한다.
-- 단일 공휴일(신정/석가탄신일/어린이날/현충일/광복절/개천절/한글날/크리스마스 등)과
-- 캘린더 규칙 휴식은 이 테이블에 seed하지 않는다.
DELETE FROM public.official_rest_weeks
WHERE NOT (
  reason ILIKE '%설%'
  OR reason ILIKE '%구정%'
  OR reason ILIKE '%추석%'
  OR reason ILIKE '%lunar%'
  OR reason ILIKE '%chuseok%'
);

-- 2025 추석 당일은 2025-10-06(월)로 ISO W41에 속한다.
-- 추석은 연도별 포함 주차 1개만 공식 휴식으로 인정한다.
DELETE FROM public.official_rest_weeks
WHERE year = 2025
  AND week_number = 40
  AND (
    reason ILIKE '%추석%'
    OR reason ILIKE '%chuseok%'
  );

-- Seed: 설/구정, 추석 명절 공식 휴식 주차
INSERT INTO public.official_rest_weeks (year, week_number, reason) VALUES
  (2025,  5, '설 연휴'),
  (2025, 41, '추석 연휴'),
  (2026,  5, '설 연휴')
ON CONFLICT (year, week_number) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: user_week_statuses.is_official_rest_override 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_week_statuses
  ADD COLUMN IF NOT EXISTS is_official_rest_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_week_statuses.is_official_rest_override
  IS '공식 휴식 주차이지만 활동이 인정되어 status=success로 기록된 경우 true. d가 아닌 a에 집계됨.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 기존 데이터 보정
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1. 기존 official_rest row 는 override=false 확인 (이미 DEFAULT false)
-- 3-2. 기존 success row 중 공식 휴식 주차에 해당하는 것이 있으면 override=true 설정
--      (시드에서 공식 휴식 할당량 소진 후 success로 채운 경우)
UPDATE public.user_week_statuses uws
SET is_official_rest_override = true
FROM public.official_rest_weeks orw
WHERE uws.year = orw.year
  AND uws.week_number = orw.week_number
  AND uws.status = 'success'
  AND uws.is_official_rest_override = false;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: override 샘플 생성
-- ═══════════════════════════════════════════════════════════════════════
-- 테스트 사용자 중 official_rest status 를 가진 row 2개를
-- success + is_official_rest_override=true 로 전환.
-- 대상: 활동 기간이 긴 사용자 (Group F, 졸업직전/graduated)

-- 4-1. 첫 번째 graduated 사용자(encre, 신서윤)의 첫 official_rest를 override
UPDATE public.user_week_statuses
SET status = 'success',
    is_official_rest_override = true,
    note = '공식 휴식 주차이나 활동 인정 (테스트 샘플)'
WHERE id = (
  SELECT uws.id
  FROM public.user_week_statuses uws
  JOIN public.user_profiles up ON up.user_id = uws.user_id
  WHERE up.growth_status = 'graduated'
    AND up.organization_slug = 'encre'
    AND uws.status = 'official_rest'
  ORDER BY uws.year, uws.week_number
  LIMIT 1
);

-- 4-2. oranke 졸업직전 사용자(안다현, approved=24)의 첫 official_rest를 override
UPDATE public.user_week_statuses
SET status = 'success',
    is_official_rest_override = true,
    note = '공식 휴식 주차이나 활동 인정 (테스트 샘플)'
WHERE id = (
  SELECT uws.id
  FROM public.user_week_statuses uws
  JOIN public.user_profiles up ON up.user_id = uws.user_id
  JOIN public.user_growth_stats ugs ON ugs.user_id = up.user_id
  WHERE up.organization_slug = 'oranke'
    AND up.growth_status = 'active'
    AND ugs.approved_weeks = 24
    AND uws.status = 'official_rest'
  ORDER BY uws.year, uws.week_number
  LIMIT 1
);

-- 4-3. override 로 인해 approved_weeks / cumulative_weeks 보정
-- approved_weeks = success count (override 포함), cumulative_weeks 변동 없음
UPDATE public.user_growth_stats ugs
SET approved_weeks = sub.success_count
FROM (
  SELECT
    user_id,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count
  FROM public.user_week_statuses
  GROUP BY user_id
) sub
WHERE ugs.user_id = sub.user_id
  AND ugs.approved_weeks != sub.success_count;

-- 4-4. point 보정 (override 로 a가 증가한 사용자)
-- 신서윤: a 30→31, stars=31*3=93, k0=31*2+3=65, l 변동 없음
UPDATE public.user_cumulative_points ucp
SET total_stars = sub.a * 3,
    total_raw_advantages = sub.a * 2 + 3,
    total_shields = (sub.a * 2 + 3) - ABS(COALESCE(ucp.total_lightnings, 0))
FROM (
  SELECT
    uws.user_id,
    COUNT(*) FILTER (WHERE uws.status = 'success') AS a
  FROM public.user_week_statuses uws
  JOIN public.user_profiles up ON up.user_id = uws.user_id
  WHERE up.growth_status = 'graduated' AND up.organization_slug = 'encre'
  GROUP BY uws.user_id
) sub
WHERE ucp.user_id = sub.user_id;

-- 안다현: a 24→25
UPDATE public.user_cumulative_points ucp
SET total_stars = sub.a * 3,
    total_raw_advantages = sub.a * 2 + 3,
    total_shields = (sub.a * 2 + 3) - ABS(COALESCE(ucp.total_lightnings, 0))
FROM (
  SELECT
    uws.user_id,
    COUNT(*) FILTER (WHERE uws.status = 'success') AS a
  FROM public.user_week_statuses uws
  JOIN public.user_profiles up ON up.user_id = uws.user_id
  JOIN public.user_growth_stats ugs ON ugs.user_id = up.user_id
  WHERE up.organization_slug = 'oranke'
    AND up.growth_status = 'active'
    AND up.display_name LIKE '%안다현%'
  GROUP BY uws.user_id
) sub
WHERE ucp.user_id = sub.user_id;
