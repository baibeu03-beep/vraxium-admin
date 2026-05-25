-- 2026-05-25_season_definitions_and_user_seasons.sql
-- 시즌 정의 + 사용자별 시즌 상태 테이블.
--   1) season_definitions: 2021~2029 시즌 경계 (봄/여름/가을/겨울)
--   2) user_season_statuses: 사용자별 시즌 참여 상태 (success/rest)
--   3) 기존 30명 더미 데이터 시드
--
-- 의존성: user_profiles, 2026-05-25_cluster3_growth_indicators.sql
-- Idempotent — 이미 적용된 환경에서 다시 실행해도 안전하다.
-- ⚠ 시드 부분은 테스트 환경 전용.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: season_definitions
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.season_definitions (
  id            smallserial PRIMARY KEY,
  season_key    text NOT NULL UNIQUE,        -- '2026-spring' 등
  season_label  text NOT NULL,               -- '2026년도 봄시즌'
  season_type   text NOT NULL                -- 'spring','summer','autumn','winter'
                CHECK (season_type IN ('spring','summer','autumn','winter')),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS season_definitions_dates_idx
  ON public.season_definitions (start_date, end_date);

GRANT SELECT ON public.season_definitions TO anon, authenticated;

-- Seed: 2021~2029 시즌 정의 (36개)
-- 공식: 52주 고정 체인 (앵커 2023-01-02 Mon)
-- 시즌 주수(seasonWeeks): 겨울 8w · 봄 16w · 여름 8w · 가을 16w
-- 집계 범위(start_date~end_date): seasonWeeks + 전환 주차 1w = 겨울 9w · 봄 17w · 여름 9w · 가을 17w
-- 전환 주차는 직전 시즌에 귀속. 모든 시작일=월요일, 종료일=일요일.
INSERT INTO public.season_definitions (season_key, season_label, season_type, start_date, end_date)
VALUES
  -- 2021
  ('2021-winter', '2021년도 겨울시즌', 'winter', '2021-01-04', '2021-03-07'),
  ('2021-spring', '2021년도 봄시즌',  'spring', '2021-03-08', '2021-07-04'),
  ('2021-summer', '2021년도 여름시즌', 'summer', '2021-07-05', '2021-09-05'),
  ('2021-autumn', '2021년도 가을시즌', 'autumn', '2021-09-06', '2022-01-02'),
  -- 2022
  ('2022-winter', '2022년도 겨울시즌', 'winter', '2022-01-03', '2022-03-06'),
  ('2022-spring', '2022년도 봄시즌',  'spring', '2022-03-07', '2022-07-03'),
  ('2022-summer', '2022년도 여름시즌', 'summer', '2022-07-04', '2022-09-04'),
  ('2022-autumn', '2022년도 가을시즌', 'autumn', '2022-09-05', '2023-01-01'),
  -- 2023
  ('2023-winter', '2023년도 겨울시즌', 'winter', '2023-01-02', '2023-03-05'),
  ('2023-spring', '2023년도 봄시즌',  'spring', '2023-03-06', '2023-07-02'),
  ('2023-summer', '2023년도 여름시즌', 'summer', '2023-07-03', '2023-09-03'),
  ('2023-autumn', '2023년도 가을시즌', 'autumn', '2023-09-04', '2023-12-31'),
  -- 2024
  ('2024-winter', '2024년도 겨울시즌', 'winter', '2024-01-01', '2024-03-03'),
  ('2024-spring', '2024년도 봄시즌',  'spring', '2024-03-04', '2024-06-30'),
  ('2024-summer', '2024년도 여름시즌', 'summer', '2024-07-01', '2024-09-01'),
  ('2024-autumn', '2024년도 가을시즌', 'autumn', '2024-09-02', '2024-12-29'),
  -- 2025
  ('2025-winter', '2025년도 겨울시즌', 'winter', '2024-12-30', '2025-03-02'),
  ('2025-spring', '2025년도 봄시즌',  'spring', '2025-03-03', '2025-06-29'),
  ('2025-summer', '2025년도 여름시즌', 'summer', '2025-06-30', '2025-08-31'),
  ('2025-autumn', '2025년도 가을시즌', 'autumn', '2025-09-01', '2025-12-28'),
  -- 2026
  ('2026-winter', '2026년도 겨울시즌', 'winter', '2025-12-29', '2026-03-01'),
  ('2026-spring', '2026년도 봄시즌',  'spring', '2026-03-02', '2026-06-28'),
  ('2026-summer', '2026년도 여름시즌', 'summer', '2026-06-29', '2026-08-30'),
  ('2026-autumn', '2026년도 가을시즌', 'autumn', '2026-08-31', '2026-12-27'),
  -- 2027
  ('2027-winter', '2027년도 겨울시즌', 'winter', '2026-12-28', '2027-02-28'),
  ('2027-spring', '2027년도 봄시즌',  'spring', '2027-03-01', '2027-06-27'),
  ('2027-summer', '2027년도 여름시즌', 'summer', '2027-06-28', '2027-08-29'),
  ('2027-autumn', '2027년도 가을시즌', 'autumn', '2027-08-30', '2027-12-26'),
  -- 2028
  ('2028-winter', '2028년도 겨울시즌', 'winter', '2027-12-27', '2028-02-27'),
  ('2028-spring', '2028년도 봄시즌',  'spring', '2028-02-28', '2028-06-25'),
  ('2028-summer', '2028년도 여름시즌', 'summer', '2028-06-26', '2028-08-27'),
  ('2028-autumn', '2028년도 가을시즌', 'autumn', '2028-08-28', '2028-12-24'),
  -- 2029
  ('2029-winter', '2029년도 겨울시즌', 'winter', '2028-12-25', '2029-02-25'),
  ('2029-spring', '2029년도 봄시즌',  'spring', '2029-02-26', '2029-06-24'),
  ('2029-summer', '2029년도 여름시즌', 'summer', '2029-06-25', '2029-08-26'),
  ('2029-autumn', '2029년도 가을시즌', 'autumn', '2029-08-27', '2029-12-23')
ON CONFLICT (season_key) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: user_season_statuses
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.user_season_statuses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       uuid NOT NULL
                REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  season_key    text NOT NULL
                REFERENCES public.season_definitions(season_key) ON DELETE CASCADE,

  status        text NOT NULL
                CHECK (status IN ('success', 'rest')),

  note          text NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, season_key)
);

CREATE INDEX IF NOT EXISTS user_season_statuses_user_id_idx
  ON public.user_season_statuses (user_id);

CREATE INDEX IF NOT EXISTS user_season_statuses_status_idx
  ON public.user_season_statuses (user_id, status);

CREATE OR REPLACE FUNCTION public.touch_user_season_statuses_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_season_statuses_set_updated_at
  ON public.user_season_statuses;

CREATE TRIGGER user_season_statuses_set_updated_at
BEFORE UPDATE ON public.user_season_statuses
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_season_statuses_updated_at();

GRANT SELECT ON public.user_season_statuses TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 30명 더미 사용자 시즌 시드
-- ═══════════════════════════════════════════════════════════════════════
-- 로직:
--   activity_started_at ~ (activity_ended_at 또는 현재일) 범위와
--   season_definitions 의 (start_date, end_date) 가 겹치는 시즌마다 row 생성.
--   기본 status = 'success'.
--   growth_status = 'seasonal_rest' 인 사용자는 마지막 겹치는 시즌을 'rest' 로.

INSERT INTO public.user_season_statuses (user_id, season_key, status)
SELECT
  up.user_id,
  sd.season_key,
  CASE
    WHEN up.growth_status = 'seasonal_rest'
     AND sd.season_key = (
       SELECT sd2.season_key
       FROM public.season_definitions sd2
       WHERE sd2.start_date <= COALESCE(up.activity_ended_at::date, CURRENT_DATE)
         AND sd2.end_date   >= up.activity_started_at::date
       ORDER BY sd2.start_date DESC
       LIMIT 1
     )
    THEN 'rest'
    ELSE 'success'
  END AS status
FROM public.user_profiles up
CROSS JOIN public.season_definitions sd
WHERE up.activity_started_at IS NOT NULL
  AND up.organization_slug IS NOT NULL
  AND sd.start_date <= COALESCE(up.activity_ended_at::date, CURRENT_DATE)
  AND sd.end_date   >= up.activity_started_at::date
ON CONFLICT (user_id, season_key) DO NOTHING;
