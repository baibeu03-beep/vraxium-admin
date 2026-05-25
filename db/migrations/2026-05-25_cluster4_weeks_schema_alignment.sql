-- 2026-05-25_cluster4_weeks_schema_alignment.sql
-- Cluster4 실데이터 전환을 위한 스키마 정렬.
--
-- 해결 대상:
--   1) weeks.week_index → week_number 정규화
--   2) weeks.started_at → start_date, ended_at → end_date 정규화
--   3) seasons.year 미존재 → season_definitions.year 추가
--   4) weeks.is_official_rest / holiday_name 미존재 → 추가 + 캘린더 규칙 반영
--   5) weeks ↔ user_week_statuses 연결 (iso_year, iso_week)
--   6) weeks.season_key 추가 (season_definitions FK)
--
-- 의존성:
--   - 2026-05-25_season_definitions_and_user_seasons.sql
--   - 2026-05-25_official_rest_weeks_and_override.sql
--   - 2026-05-25_week_season_key_attribution.sql (resolve_season_key 함수)
--   - weeks 테이블 존재 가정 (Career-Resume 원본 또는 fresh 배포)
--
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 0: weeks 테이블 안전 생성 (fresh 배포용)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.weeks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.weeks TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: season_definitions.year 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.season_definitions
  ADD COLUMN IF NOT EXISTS year smallint;

UPDATE public.season_definitions
SET year = SPLIT_PART(season_key, '-', 1)::smallint
WHERE year IS NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: weeks 정규 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS week_number smallint,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS season_key text,
  ADD COLUMN IF NOT EXISTS is_official_rest boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS holiday_name text,
  ADD COLUMN IF NOT EXISTS iso_year smallint,
  ADD COLUMN IF NOT EXISTS iso_week smallint;

-- season_key FK (safe — ignore if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weeks_season_key_fkey'
      AND conrelid = 'public.weeks'::regclass
  ) THEN
    ALTER TABLE public.weeks
      ADD CONSTRAINT weeks_season_key_fkey
      FOREIGN KEY (season_key) REFERENCES public.season_definitions(season_key)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 레거시 컬럼에서 정규 컬럼으로 백필
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1. week_number ← week_index
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'week_index'
  ) THEN
    EXECUTE 'UPDATE public.weeks SET week_number = week_index WHERE week_number IS NULL';
  END IF;
END;
$$;

-- 3-2. start_date ← started_at::date
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'started_at'
  ) THEN
    EXECUTE 'UPDATE public.weeks SET start_date = started_at::date WHERE start_date IS NULL';
  END IF;
END;
$$;

-- 3-3. end_date ← ended_at::date
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'ended_at'
  ) THEN
    EXECUTE 'UPDATE public.weeks SET end_date = ended_at::date WHERE end_date IS NULL';
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: ISO 연도/주차 계산
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.weeks
SET iso_year = EXTRACT(ISOYEAR FROM start_date)::smallint,
    iso_week = EXTRACT(WEEK FROM start_date)::smallint
WHERE start_date IS NOT NULL
  AND (iso_year IS NULL OR iso_week IS NULL);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: season_key 계산 (resolve_season_key 함수 사용)
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
-- PART 6: 공식 휴식 판정 (캘린더 규칙 + 명절)
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

-- 6-1. 봄/가을 시즌 6~8주차, 14~16주차 → 공식 휴식
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

-- 6-2. 명절(설/구정, 추석) → official_rest_weeks 테이블에서 가져오기
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
-- PART 7: 인덱스
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS weeks_iso_year_week_idx
  ON public.weeks (iso_year, iso_week);

CREATE INDEX IF NOT EXISTS weeks_start_date_idx
  ON public.weeks (start_date);

CREATE INDEX IF NOT EXISTS weeks_season_key_idx
  ON public.weeks (season_key);

-- UNIQUE (iso_year, iso_week) — 1주일 = 1 row 보장
-- 기존 데이터에 중복이 있을 수 있으므로 DO 블록으로 안전하게 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weeks_iso_year_iso_week_unique'
      AND conrelid = 'public.weeks'::regclass
  ) THEN
    ALTER TABLE public.weeks
      ADD CONSTRAINT weeks_iso_year_iso_week_unique
      UNIQUE (iso_year, iso_week);
  END IF;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'weeks (iso_year, iso_week) unique constraint skipped — duplicates exist.';
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 8: 검증 (DML 아님)
-- ═══════════════════════════════════════════════════════════════════════

/*
-- 8-1. 정규 컬럼 채워짐 확인
SELECT
  COUNT(*) AS total,
  COUNT(week_number)     AS has_week_number,
  COUNT(start_date)      AS has_start_date,
  COUNT(end_date)        AS has_end_date,
  COUNT(season_key)      AS has_season_key,
  COUNT(iso_year)        AS has_iso_year,
  COUNT(iso_week)        AS has_iso_week,
  COUNT(*) FILTER (WHERE is_official_rest) AS official_rest_count,
  COUNT(holiday_name)    AS has_holiday_name
FROM public.weeks;

-- 8-2. season_definitions.year 확인
SELECT season_key, year, season_type, start_date, end_date
FROM public.season_definitions
ORDER BY start_date;

-- 8-3. 공식 휴식 주차 목록
SELECT w.iso_year, w.iso_week, w.week_number, w.season_key, w.holiday_name
FROM public.weeks w
WHERE w.is_official_rest = true
ORDER BY w.iso_year, w.iso_week;
*/
