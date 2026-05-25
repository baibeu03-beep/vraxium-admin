-- 2026-05-25_week_season_key_attribution.sql
-- Case 2: 주차→시즌 귀속 로직.
--   1) user_week_statuses.season_key 컬럼 추가
--   2) resolve_season_key(date) SQL 함수 — 전환 주차 포함이므로 시즌이 연속, gap 없음
--   3) 기존 row backfill
--
-- 의존성: season_definitions, user_week_statuses 존재 가정
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: user_week_statuses.season_key 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_week_statuses
  ADD COLUMN IF NOT EXISTS season_key text NULL
  REFERENCES public.season_definitions(season_key) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS user_week_statuses_season_key_idx
  ON public.user_week_statuses (season_key);

COMMENT ON COLUMN public.user_week_statuses.season_key
  IS '이 주차가 귀속되는 시즌. 시즌 범위 내이면 해당 시즌, gap 주차이면 직전 시즌.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: resolve_season_key(date) 함수
-- ═══════════════════════════════════════════════════════════════════════
-- 주어진 날짜(주차 시작일)가 어느 시즌에 속하는지 결정.
--
-- 규칙:
--   1) 날짜가 시즌 범위(start_date ~ end_date) 안이면 해당 시즌
--   2) 시즌 사이 gap이면 end_date 가 가장 가까운 직전 시즌
--   3) 어떤 시즌보다도 이전이면 NULL
--   4) 마지막 시즌 이후 gap이면 마지막 시즌

CREATE OR REPLACE FUNCTION public.resolve_season_key(p_date date)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_key text;
BEGIN
  -- 1차: 범위 안에 들어가는 시즌
  SELECT season_key INTO v_key
  FROM public.season_definitions
  WHERE p_date >= start_date AND p_date <= end_date
  ORDER BY start_date
  LIMIT 1;

  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;

  -- 2차: gap → end_date < p_date 인 시즌 중 가장 가까운 것 (직전 시즌)
  SELECT season_key INTO v_key
  FROM public.season_definitions
  WHERE end_date < p_date
  ORDER BY end_date DESC
  LIMIT 1;

  RETURN v_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_season_key(date) TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 기존 데이터 backfill
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.user_week_statuses
SET season_key = public.resolve_season_key(week_start_date)
WHERE season_key IS NULL;
