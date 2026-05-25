-- 2026-05-25_cluster4_weeks_backfill_from_uws.sql
-- user_week_statuses에 존재하지만 weeks 테이블에 없는 주차를 일괄 생성.
--
-- 문제:
--   Career-Resume 앱이 weeks row를 on-demand 생성하므로,
--   user_week_statuses에 기록된 과거 주차 중 weeks row가 없는 경우가 있다.
--   이로 인해 weeks JOIN 실패 → endDate null, is_official_rest 판정 불가.
--
-- 해결:
--   user_week_statuses.week_start_date 기준으로 누락된 weeks row를 일괄 INSERT.
--   UUID는 deterministic하게 생성 (날짜 기반).
--
-- 의존성:
--   - 2026-05-25_cluster4_weeks_schema_alignment.sql
--   - 2026-05-25_cluster3_growth_indicators.sql (user_week_statuses)
--
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: user_week_statuses에서 누락된 weeks row 생성
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.weeks (id, start_date, end_date, week_number, iso_year, iso_week, created_at)
SELECT DISTINCT
  gen_random_uuid() AS id,
  uws.week_start_date AS start_date,
  (uws.week_start_date + 6)::date AS end_date,
  EXTRACT(WEEK FROM uws.week_start_date)::smallint AS week_number,
  EXTRACT(ISOYEAR FROM uws.week_start_date)::smallint AS iso_year,
  EXTRACT(WEEK FROM uws.week_start_date)::smallint AS iso_week,
  now()
FROM public.user_week_statuses uws
WHERE NOT EXISTS (
  SELECT 1 FROM public.weeks w
  WHERE w.start_date = uws.week_start_date
)
AND uws.week_start_date IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 신규 생성된 row에 season_key 할당
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'resolve_season_key'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE '
      UPDATE public.weeks
      SET season_key = public.resolve_season_key(start_date)
      WHERE season_key IS NULL AND start_date IS NOT NULL
    ';
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 시즌 내 주차 번호 계산
-- ═══════════════════════════════════════════════════════════════════════
-- season_definitions.start_date 기준으로 (start_date - season_start) / 7 + 1

UPDATE public.weeks w
SET week_number = ((w.start_date - sd.start_date) / 7 + 1)::smallint
FROM public.season_definitions sd
WHERE w.season_key = sd.season_key
  AND w.start_date >= sd.start_date
  AND w.start_date <= sd.end_date;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 공식 휴식 판정
-- true 조건:
--   - 봄/가을 시즌 6~8주차, 14~16주차
--   - 설/구정 포함 ISO 주차
--   - 추석 포함 ISO 주차
-- false 조건:
--   - 석가탄신일/어린이날/현충일/광복절/개천절/한글날/크리스마스 등 단일 공휴일
--   - 전환 주차
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.weeks
SET is_official_rest = false,
    holiday_name = NULL
WHERE is_official_rest = true
   OR holiday_name IS NOT NULL;

-- 4-1. 봄/가을 시즌 6~8주차, 14~16주차
UPDATE public.weeks w
SET is_official_rest = true
FROM public.season_definitions sd
WHERE w.season_key = sd.season_key
  AND sd.season_type IN ('spring', 'autumn')
  AND w.week_number IS NOT NULL
  AND (
    (w.week_number >= 6 AND w.week_number <= 8)
    OR (w.week_number >= 14 AND w.week_number <= 16)
  )
  AND w.is_official_rest = false;

-- 4-2. 명절(설/구정, 추석)
UPDATE public.weeks w
SET is_official_rest = true,
    holiday_name = orw.reason
FROM public.official_rest_weeks orw
WHERE w.iso_year = orw.year
  AND w.iso_week = orw.week_number
  AND (
    orw.reason ILIKE '%설%'
    OR orw.reason ILIKE '%구정%'
    OR orw.reason ILIKE '%추석%'
    OR orw.reason ILIKE '%lunar%'
    OR orw.reason ILIKE '%chuseok%'
  );


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: 검증
-- ═══════════════════════════════════════════════════════════════════════

/*
-- 5-1. 모든 user_week_statuses가 weeks에 매칭되는지
SELECT
  COUNT(*) AS total_uws,
  COUNT(w.id) AS matched_weeks,
  COUNT(*) - COUNT(w.id) AS unmatched
FROM public.user_week_statuses uws
LEFT JOIN public.weeks w ON w.start_date = uws.week_start_date;

-- 5-2. weeks 총 row 수
SELECT COUNT(*) AS total_weeks FROM public.weeks;

-- 5-3. 공식 휴식 주차 확인
SELECT w.season_key, w.week_number, w.start_date, w.end_date,
       w.is_official_rest, w.holiday_name
FROM public.weeks w
WHERE w.is_official_rest = true
ORDER BY w.start_date;
*/
