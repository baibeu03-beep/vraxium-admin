-- 2026-05-25_club_rank_weekly_points.sql
-- 클럽 강화 품계 계산을 위한 주차별 포인트 테이블.
--   user_weekly_points: 주차별 points / advantages / penalty 저장.
--   user_club_rank_frozen: graduated / suspended 시 고정된 품계.
--   시드 데이터: 기존 user_week_statuses 기반 자동 생성.
--
-- 의존성: 2026-05-25_cluster3_growth_indicators.sql, _seed_diversify.sql 적용 후.
-- Idempotent.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 스키마
-- ═══════════════════════════════════════════════════════════════════════

-- 1-1. user_weekly_points: 주차별 포인트 분해 ─────────────────────────
CREATE TABLE IF NOT EXISTS public.user_weekly_points (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         uuid NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  year            smallint NOT NULL,
  week_number     smallint NOT NULL
                  CHECK (week_number >= 1 AND week_number <= 53),
  week_start_date date NOT NULL,

  points          integer NOT NULL DEFAULT 0,
  advantages      integer NOT NULL DEFAULT 0,
  penalty         integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, year, week_number)
);

CREATE INDEX IF NOT EXISTS user_weekly_points_user_id_idx
  ON public.user_weekly_points (user_id);

CREATE INDEX IF NOT EXISTS user_weekly_points_year_week_idx
  ON public.user_weekly_points (year, week_number);

CREATE OR REPLACE FUNCTION public.touch_user_weekly_points_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_weekly_points_set_updated_at
  ON public.user_weekly_points;

CREATE TRIGGER user_weekly_points_set_updated_at
BEFORE UPDATE ON public.user_weekly_points
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_weekly_points_updated_at();

GRANT SELECT ON public.user_weekly_points TO anon, authenticated;

COMMENT ON TABLE public.user_weekly_points
  IS '주차별 points/advantages/penalty. 클럽 강화 품계 계산의 원천.';
COMMENT ON COLUMN public.user_weekly_points.points
  IS '해당 주 획득 points (누적 아님).';
COMMENT ON COLUMN public.user_weekly_points.advantages
  IS '해당 주 획득 advantages (누적 아님).';
COMMENT ON COLUMN public.user_weekly_points.penalty
  IS '해당 주 penalty (양수 저장, 계산 시 차감).';


-- 1-2. user_club_rank_frozen: 졸업/중단 시 고정된 품계 ────────────────
CREATE TABLE IF NOT EXISTS public.user_club_rank_frozen (
  user_id              uuid PRIMARY KEY
                       REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  avg_percentile       numeric(5,2) NOT NULL,
  rank_grade           text NOT NULL,
  frozen_at            timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.user_club_rank_frozen TO anon, authenticated;

COMMENT ON TABLE public.user_club_rank_frozen
  IS 'graduated / suspended 시 고정된 클럽 강화 품계. 한 번 고정 후 갱신하지 않음.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 시드 데이터 — user_weekly_points
-- ═══════════════════════════════════════════════════════════════════════
--
-- 전략:
--   user_week_statuses 의 각 행을 기반으로 주차별 포인트 생성.
--   status 에 따라 다른 분포:
--     success       → points 2~4, advantages 0~2, penalty 0
--     fail          → points 0~1, advantages 0,   penalty 1~2
--     personal_rest → all 0
--     official_rest → all 0
--
--   사용자별 rn(row_number)을 모듈러 연산으로 분산해 다양성 확보.
--   기존 user_cumulative_points 와의 정합성은 시드 전용이므로 보장하지 않음.
--   (운영에서는 user_weekly_points 가 원천이 되고 cumulative 는 집계로 대체)

INSERT INTO public.user_weekly_points
  (user_id, year, week_number, week_start_date, points, advantages, penalty)
SELECT
  uws.user_id,
  uws.year,
  uws.week_number,
  uws.week_start_date,
  CASE uws.status
    WHEN 'success' THEN 2 + (rn % 3)             -- 2, 3, 4
    WHEN 'fail'    THEN (rn % 2)                  -- 0, 1
    ELSE 0
  END AS points,
  CASE uws.status
    WHEN 'success' THEN (rn % 3)                  -- 0, 1, 2
    ELSE 0
  END AS advantages,
  CASE uws.status
    WHEN 'fail'    THEN 1 + (rn % 2)              -- 1, 2
    ELSE 0
  END AS penalty
FROM (
  SELECT
    user_id, year, week_number, week_start_date, status,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY year, week_number) AS rn
  FROM public.user_week_statuses
) uws
ON CONFLICT (user_id, year, week_number) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 시드 데이터 — user_club_rank_frozen (graduated/suspended)
-- ═══════════════════════════════════════════════════════════════════════
--
-- graduated / suspended 사용자에 대해 고정 품계 사전 계산.
-- 실제 운영에서는 API 가 상태 전이 시점에 frozen row 를 생성하지만,
-- 시드에서는 현재 데이터 기반으로 일괄 계산.

-- 1) 주차별 점수 → 주차별 등수 → 주차별 백분위 → 평균 백분위 → 품계
--    를 한 CTE 체인으로 처리.

WITH weekly_scores AS (
  SELECT
    uwp.user_id,
    uwp.year,
    uwp.week_number,
    (uwp.points * 1) + (uwp.advantages * 3) - (uwp.penalty * 5) AS weekly_score,
    ROW_NUMBER() OVER (
      PARTITION BY uwp.user_id ORDER BY uwp.year, uwp.week_number
    ) AS user_week_seq
  FROM public.user_weekly_points uwp
),
week_participants AS (
  SELECT year, week_number, COUNT(DISTINCT user_id) AS total
  FROM weekly_scores
  GROUP BY year, week_number
),
weekly_ranked AS (
  SELECT
    ws.user_id,
    ws.year,
    ws.week_number,
    ws.weekly_score,
    ws.user_week_seq,
    RANK() OVER (
      PARTITION BY ws.year, ws.week_number
      ORDER BY ws.weekly_score DESC
    ) AS weekly_rank,
    wp.total
  FROM weekly_scores ws
  JOIN week_participants wp
    ON wp.year = ws.year AND wp.week_number = ws.week_number
),
weekly_percentiles AS (
  SELECT
    user_id,
    year,
    week_number,
    user_week_seq,
    CASE
      WHEN total <= 1 THEN 1
      ELSE CEIL(((weekly_rank - 1)::numeric / (total - 1)) * 99)::integer + 1
    END AS weekly_percentile
  FROM weekly_ranked
),
avg_pct AS (
  SELECT
    user_id,
    CEIL(AVG(weekly_percentile) * 100) / 100.0 AS avg_percentile
  FROM weekly_percentiles
  WHERE user_week_seq > 1
  GROUP BY user_id
  HAVING COUNT(*) > 0
),
frozen_candidates AS (
  SELECT
    ap.user_id,
    ap.avg_percentile,
    CASE
      WHEN ap.avg_percentile <= 10  THEN '정승'
      WHEN ap.avg_percentile <= 20  THEN '정1품'
      WHEN ap.avg_percentile <= 30  THEN '정2품'
      WHEN ap.avg_percentile <= 40  THEN '정3품'
      WHEN ap.avg_percentile <= 50  THEN '정4품'
      WHEN ap.avg_percentile <= 60  THEN '정5품'
      WHEN ap.avg_percentile <= 70  THEN '정6품'
      WHEN ap.avg_percentile <= 80  THEN '정7품'
      WHEN ap.avg_percentile <= 90  THEN '정8품'
      ELSE '정9품'
    END AS rank_grade
  FROM avg_pct ap
  JOIN public.user_profiles up ON up.user_id = ap.user_id
  WHERE up.growth_status IN ('graduated', 'suspended')
)
INSERT INTO public.user_club_rank_frozen (user_id, avg_percentile, rank_grade, frozen_at)
SELECT user_id, avg_percentile, rank_grade, now()
FROM frozen_candidates
ON CONFLICT (user_id) DO NOTHING;
