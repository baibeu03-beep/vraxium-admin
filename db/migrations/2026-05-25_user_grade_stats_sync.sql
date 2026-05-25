-- 2026-05-25_user_grade_stats_sync.sql
-- user_grade_stats 테이블 안전 생성 + user_weekly_points 기반 일괄 동기화.
--
-- 정책:
--   - CREATE TABLE IF NOT EXISTS: 이미 존재하면 스킵.
--   - 기존 데이터 DROP/RECREATE 절대 금지.
--   - UPSERT (ON CONFLICT ... DO UPDATE) 방식으로만 갱신.
--   - graduated/suspended 사용자는 user_club_rank_frozen 값 우선 사용.
--
-- 의존성:
--   - 2026-05-25_club_rank_weekly_points.sql (user_weekly_points, user_club_rank_frozen)
--
-- grade 숫자 매핑 (프론트 Cluster3Content.tsx 기준):
--   grade=1  → 정승   (avgPercentile 1~10%)
--   grade=2  → 정 1품 (avgPercentile 11~20%)
--   grade=3  → 정 2품 (avgPercentile 21~30%)
--   ...
--   grade=10 → 정 9품 (avgPercentile 91~100%)
--
-- grade_label 형식: "정승" 또는 "정 N품" (공백 포함).
-- Idempotent.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 테이블 안전 생성 (이미 존재하면 무시)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.user_grade_stats (
  user_id        uuid PRIMARY KEY
                 REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  avg_percentile numeric(5,2) NULL,
  grade          integer NULL
                 CHECK (grade IS NULL OR (grade >= 1 AND grade <= 10)),
  grade_label    text NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.user_grade_stats TO anon, authenticated;

COMMENT ON TABLE public.user_grade_stats
  IS '클럽 강화 품계 캐시. user_weekly_points 기반 계산 결과를 UPSERT. 프론트 /api/profile 이 직접 SELECT.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 30명 더미 데이터 기반 일괄 동기화 (UPSERT)
-- ═══════════════════════════════════════════════════════════════════════
--
-- 계산 흐름:
--   user_weekly_points → weekly_score → RANK() → percentile → avg → grade
--
-- 백분위 공식 (확정 정책):
--   1등 = 1%, 최하위 = 100%
--   total <= 1: 1
--   else: CEIL(((rank - 1) / (total - 1)) * 99) + 1
--
-- 평균 백분위: 온보딩 1주차 제외, 소수점 셋째 자리 올림 → 2자리 표기.
-- grade 매핑: CEIL(avg_percentile) 기준 10단계.

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
grade_computed AS (
  SELECT
    ap.user_id,
    ap.avg_percentile,
    CASE
      WHEN CEIL(ap.avg_percentile) <= 10  THEN 1
      WHEN CEIL(ap.avg_percentile) <= 20  THEN 2
      WHEN CEIL(ap.avg_percentile) <= 30  THEN 3
      WHEN CEIL(ap.avg_percentile) <= 40  THEN 4
      WHEN CEIL(ap.avg_percentile) <= 50  THEN 5
      WHEN CEIL(ap.avg_percentile) <= 60  THEN 6
      WHEN CEIL(ap.avg_percentile) <= 70  THEN 7
      WHEN CEIL(ap.avg_percentile) <= 80  THEN 8
      WHEN CEIL(ap.avg_percentile) <= 90  THEN 9
      ELSE 10
    END AS grade,
    CASE
      WHEN CEIL(ap.avg_percentile) <= 10  THEN '정승'
      WHEN CEIL(ap.avg_percentile) <= 20  THEN '정 1품'
      WHEN CEIL(ap.avg_percentile) <= 30  THEN '정 2품'
      WHEN CEIL(ap.avg_percentile) <= 40  THEN '정 3품'
      WHEN CEIL(ap.avg_percentile) <= 50  THEN '정 4품'
      WHEN CEIL(ap.avg_percentile) <= 60  THEN '정 5품'
      WHEN CEIL(ap.avg_percentile) <= 70  THEN '정 6품'
      WHEN CEIL(ap.avg_percentile) <= 80  THEN '정 7품'
      WHEN CEIL(ap.avg_percentile) <= 90  THEN '정 8품'
      ELSE '정 9품'
    END AS grade_label
  FROM avg_pct ap
),
-- graduated/suspended 는 user_club_rank_frozen 값 우선 사용
frozen_override AS (
  SELECT
    ucrf.user_id,
    ucrf.avg_percentile,
    CASE
      WHEN CEIL(ucrf.avg_percentile) <= 10  THEN 1
      WHEN CEIL(ucrf.avg_percentile) <= 20  THEN 2
      WHEN CEIL(ucrf.avg_percentile) <= 30  THEN 3
      WHEN CEIL(ucrf.avg_percentile) <= 40  THEN 4
      WHEN CEIL(ucrf.avg_percentile) <= 50  THEN 5
      WHEN CEIL(ucrf.avg_percentile) <= 60  THEN 6
      WHEN CEIL(ucrf.avg_percentile) <= 70  THEN 7
      WHEN CEIL(ucrf.avg_percentile) <= 80  THEN 8
      WHEN CEIL(ucrf.avg_percentile) <= 90  THEN 9
      ELSE 10
    END AS grade,
    CASE
      WHEN CEIL(ucrf.avg_percentile) <= 10  THEN '정승'
      WHEN CEIL(ucrf.avg_percentile) <= 20  THEN '정 1품'
      WHEN CEIL(ucrf.avg_percentile) <= 30  THEN '정 2품'
      WHEN CEIL(ucrf.avg_percentile) <= 40  THEN '정 3품'
      WHEN CEIL(ucrf.avg_percentile) <= 50  THEN '정 4품'
      WHEN CEIL(ucrf.avg_percentile) <= 60  THEN '정 5품'
      WHEN CEIL(ucrf.avg_percentile) <= 70  THEN '정 6품'
      WHEN CEIL(ucrf.avg_percentile) <= 80  THEN '정 7품'
      WHEN CEIL(ucrf.avg_percentile) <= 90  THEN '정 8품'
      ELSE '정 9품'
    END AS grade_label
  FROM public.user_club_rank_frozen ucrf
),
-- 최종: frozen 있으면 frozen 값, 없으면 실시간 계산값
final_grades AS (
  SELECT
    COALESCE(fo.user_id, gc.user_id) AS user_id,
    COALESCE(fo.avg_percentile, gc.avg_percentile) AS avg_percentile,
    COALESCE(fo.grade, gc.grade) AS grade,
    COALESCE(fo.grade_label, gc.grade_label) AS grade_label
  FROM grade_computed gc
  FULL OUTER JOIN frozen_override fo ON fo.user_id = gc.user_id
)
INSERT INTO public.user_grade_stats (user_id, avg_percentile, grade, grade_label)
SELECT user_id, avg_percentile, grade, grade_label
FROM final_grades
WHERE user_id IS NOT NULL
ON CONFLICT (user_id) DO UPDATE
  SET avg_percentile = EXCLUDED.avg_percentile,
      grade = EXCLUDED.grade,
      grade_label = EXCLUDED.grade_label,
      updated_at = now();


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 검증 쿼리 (DML 아님)
-- ═══════════════════════════════════════════════════════════════════════

/*
-- 3-1. user_grade_stats 전체 row 수
SELECT COUNT(*) AS total_rows FROM public.user_grade_stats;

-- 3-2. 전체 데이터 확인
SELECT
  ugs.user_id,
  up.display_name,
  up.organization_slug,
  up.growth_status,
  ugs.avg_percentile,
  ugs.grade,
  ugs.grade_label,
  CASE WHEN ucrf.user_id IS NOT NULL THEN 'frozen' ELSE 'live' END AS source
FROM public.user_grade_stats ugs
JOIN public.user_profiles up ON up.user_id = ugs.user_id
LEFT JOIN public.user_club_rank_frozen ucrf ON ucrf.user_id = ugs.user_id
ORDER BY ugs.avg_percentile;

-- 3-3. grade 매핑 정합성 체크
SELECT
  user_id,
  avg_percentile,
  grade,
  grade_label,
  CASE
    WHEN grade = 1  AND grade_label = '정승'   THEN 'OK'
    WHEN grade = 2  AND grade_label = '정 1품' THEN 'OK'
    WHEN grade = 3  AND grade_label = '정 2품' THEN 'OK'
    WHEN grade = 4  AND grade_label = '정 3품' THEN 'OK'
    WHEN grade = 5  AND grade_label = '정 4품' THEN 'OK'
    WHEN grade = 6  AND grade_label = '정 5품' THEN 'OK'
    WHEN grade = 7  AND grade_label = '정 6품' THEN 'OK'
    WHEN grade = 8  AND grade_label = '정 7품' THEN 'OK'
    WHEN grade = 9  AND grade_label = '정 8품' THEN 'OK'
    WHEN grade = 10 AND grade_label = '정 9품' THEN 'OK'
    ELSE 'MISMATCH'
  END AS grade_check
FROM public.user_grade_stats;
*/
