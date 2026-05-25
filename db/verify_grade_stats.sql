-- ═══════════════════════════════════════════════════════════════════════
-- V-G1. user_grade_stats 전체 row 수 + 분포
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE grade IS NOT NULL) AS with_grade,
  COUNT(*) FILTER (WHERE grade IS NULL) AS without_grade
FROM public.user_grade_stats;


-- ═══════════════════════════════════════════════════════════════════════
-- V-G2. 전체 데이터 + 그룹 + frozen 여부
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN rn BETWEEN  1 AND  5 THEN 'A: 온보딩'
    WHEN rn BETWEEN  6 AND 10 THEN 'B: 우수'
    WHEN rn BETWEEN 11 AND 15 THEN 'C: 평균'
    WHEN rn BETWEEN 16 AND 20 THEN 'D: 휴식'
    WHEN rn BETWEEN 21 AND 25 THEN 'E: 실패'
    WHEN rn BETWEEN 26 AND 30 THEN 'F: 졸업직전'
  END AS "그룹",
  rn AS "#",
  up.display_name,
  up.growth_status,
  ugs.avg_percentile,
  ugs.grade,
  ugs.grade_label,
  CASE WHEN ucrf.user_id IS NOT NULL THEN 'frozen' ELSE 'live' END AS source,
  -- grade_label 정합성
  CASE
    WHEN ugs.grade = 1  AND ugs.grade_label = '정승'   THEN 'OK'
    WHEN ugs.grade = 2  AND ugs.grade_label = '정 1품' THEN 'OK'
    WHEN ugs.grade = 3  AND ugs.grade_label = '정 2품' THEN 'OK'
    WHEN ugs.grade = 4  AND ugs.grade_label = '정 3품' THEN 'OK'
    WHEN ugs.grade = 5  AND ugs.grade_label = '정 4품' THEN 'OK'
    WHEN ugs.grade = 6  AND ugs.grade_label = '정 5품' THEN 'OK'
    WHEN ugs.grade = 7  AND ugs.grade_label = '정 6품' THEN 'OK'
    WHEN ugs.grade = 8  AND ugs.grade_label = '정 7품' THEN 'OK'
    WHEN ugs.grade = 9  AND ugs.grade_label = '정 8품' THEN 'OK'
    WHEN ugs.grade = 10 AND ugs.grade_label = '정 9품' THEN 'OK'
    WHEN ugs.grade IS NULL                              THEN 'NULL'
    ELSE 'MISMATCH'
  END AS label_chk,
  -- avg_percentile → grade 매핑 정합성
  CASE
    WHEN ugs.avg_percentile IS NULL THEN 'NULL'
    WHEN CEIL(ugs.avg_percentile) <= 10  AND ugs.grade = 1  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 20  AND ugs.grade = 2  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 30  AND ugs.grade = 3  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 40  AND ugs.grade = 4  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 50  AND ugs.grade = 5  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 60  AND ugs.grade = 6  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 70  AND ugs.grade = 7  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 80  AND ugs.grade = 8  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 90  AND ugs.grade = 9  THEN 'OK'
    WHEN CEIL(ugs.avg_percentile) <= 100 AND ugs.grade = 10 THEN 'OK'
    ELSE 'MISMATCH'
  END AS grade_chk
FROM (
  SELECT user_id, display_name, growth_status,
         ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
  FROM public.user_profiles
  WHERE organization_slug IS NOT NULL
  ORDER BY created_at, user_id
  LIMIT 30
) up
LEFT JOIN public.user_grade_stats ugs ON ugs.user_id = up.user_id
LEFT JOIN public.user_club_rank_frozen ucrf ON ucrf.user_id = up.user_id
ORDER BY rn;


-- ═══════════════════════════════════════════════════════════════════════
-- V-G3. 품계별 분포
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  ugs.grade,
  ugs.grade_label,
  COUNT(*) AS cnt,
  ROUND(MIN(ugs.avg_percentile), 2) AS min_pct,
  ROUND(MAX(ugs.avg_percentile), 2) AS max_pct
FROM public.user_grade_stats ugs
GROUP BY ugs.grade, ugs.grade_label
ORDER BY ugs.grade;


-- ═══════════════════════════════════════════════════════════════════════
-- V-G4. /api/profile 응답 시뮬레이션
--   parseFloat(avg_percentile) || 0  →  avgPercentile
--   grade || 10                      →  grade
--   grade_label || '정 9품'           →  gradeLabel
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  up.display_name,
  COALESCE(ugs.avg_percentile, 0) AS "avgPercentile (API)",
  COALESCE(ugs.grade, 10) AS "grade (API)",
  COALESCE(ugs.grade_label, '정 9품') AS "gradeLabel (API)"
FROM public.user_profiles up
LEFT JOIN public.user_grade_stats ugs ON ugs.user_id = up.user_id
WHERE up.organization_slug IS NOT NULL
ORDER BY COALESCE(ugs.avg_percentile, 999);
