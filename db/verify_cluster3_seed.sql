-- ═══════════════════════════════════════════════════════════════════════
-- V-1. 그룹별 분포 + Period 정합성 (a+b+c+d=h, approved_weeks=a)
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
  up.organization_slug AS org,
  up.growth_status,
  up.activity_started_at::date AS started,
  up.activity_ended_at::date AS ended,
  COUNT(*) FILTER (WHERE uws.status = 'success')       AS a,
  COUNT(*) FILTER (WHERE uws.status = 'fail')           AS b,
  COUNT(*) FILTER (WHERE uws.status = 'personal_rest')  AS c,
  COUNT(*) FILTER (WHERE uws.status = 'official_rest')  AS d,
  COUNT(*)                                               AS h,
  COUNT(*) FILTER (WHERE uws.status != 'official_rest') AS e,
  ugs.approved_weeks,
  ugs.cumulative_weeks,
  CASE WHEN COUNT(*) FILTER (WHERE uws.status = 'success') = COALESCE(ugs.approved_weeks, 0)
       THEN 'OK' ELSE 'MISMATCH' END AS approved_chk,
  CASE WHEN COUNT(*) = COALESCE(ugs.cumulative_weeks, 0)
       THEN 'OK' ELSE 'MISMATCH' END AS cumul_chk
FROM (
  SELECT user_id, display_name, organization_slug, growth_status,
         activity_started_at, activity_ended_at,
         ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
  FROM public.user_profiles
  WHERE organization_slug IS NOT NULL
  ORDER BY created_at, user_id
  LIMIT 30
) up
LEFT JOIN public.user_week_statuses uws ON uws.user_id = up.user_id
LEFT JOIN public.user_growth_stats  ugs ON ugs.user_id = up.user_id
GROUP BY rn, up.display_name, up.organization_slug, up.growth_status,
         up.activity_started_at, up.activity_ended_at,
         ugs.approved_weeks, ugs.cumulative_weeks
ORDER BY rn;


-- ═══════════════════════════════════════════════════════════════════════
-- V-2. Point 정합성 (total_shields = total_raw_advantages - ABS(total_lightnings))
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
  up.organization_slug AS org,
  ucp.total_stars          AS j,
  ucp.total_raw_advantages AS k0,
  ucp.total_lightnings     AS l,
  ucp.total_shields        AS k_stored,
  ucp.total_raw_advantages - ABS(COALESCE(ucp.total_lightnings, 0)) AS k_calc,
  CASE WHEN COALESCE(ucp.total_shields, 0)
          = COALESCE(ucp.total_raw_advantages, 0) - ABS(COALESCE(ucp.total_lightnings, 0))
       THEN 'OK' ELSE 'MISMATCH' END AS integrity
FROM (
  SELECT user_id, display_name, organization_slug,
         ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
  FROM public.user_profiles
  WHERE organization_slug IS NOT NULL
  ORDER BY created_at, user_id
  LIMIT 30
) up
LEFT JOIN public.user_cumulative_points ucp ON ucp.user_id = up.user_id
ORDER BY rn;


-- ═══════════════════════════════════════════════════════════════════════
-- V-3. 졸업 가능 판정 (e >= threshold)
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
  up.organization_slug AS org,
  up.growth_status,
  COUNT(*) FILTER (WHERE uws.status != 'official_rest') AS e_growable,
  CASE up.organization_slug
    WHEN 'encre'   THEN 30
    WHEN 'phalanx' THEN 30
    WHEN 'oranke'  THEN 25
  END AS threshold,
  CASE WHEN COUNT(*) FILTER (WHERE uws.status != 'official_rest')
         >= CASE up.organization_slug
              WHEN 'encre'   THEN 30
              WHEN 'phalanx' THEN 30
              WHEN 'oranke'  THEN 25
            END
       THEN 'ELIGIBLE' ELSE 'NOT_YET' END AS grad_status
FROM (
  SELECT user_id, display_name, organization_slug, growth_status,
         ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
  FROM public.user_profiles
  WHERE organization_slug IS NOT NULL
  ORDER BY created_at, user_id
  LIMIT 30
) up
LEFT JOIN public.user_week_statuses uws ON uws.user_id = up.user_id
GROUP BY rn, up.display_name, up.organization_slug, up.growth_status
ORDER BY rn;


-- ═══════════════════════════════════════════════════════════════════════
-- V-4. 그룹별 통계 요약
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
  COUNT(*) AS users,
  ROUND(AVG(ugs.approved_weeks), 1) AS avg_approved,
  ROUND(AVG(ugs.cumulative_weeks), 1) AS avg_cumulative,
  ROUND(AVG(ucp.total_stars), 1) AS avg_stars,
  ROUND(AVG(ucp.total_raw_advantages), 1) AS avg_k0,
  ROUND(AVG(ABS(COALESCE(ucp.total_lightnings, 0))), 1) AS avg_penalty,
  ROUND(AVG(ucp.total_shields), 1) AS avg_net_adv,
  STRING_AGG(DISTINCT up.growth_status, ', ' ORDER BY up.growth_status) AS statuses
FROM (
  SELECT user_id, growth_status,
         ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
  FROM public.user_profiles
  WHERE organization_slug IS NOT NULL
  ORDER BY created_at, user_id
  LIMIT 30
) up
LEFT JOIN public.user_growth_stats ugs ON ugs.user_id = up.user_id
LEFT JOIN public.user_cumulative_points ucp ON ucp.user_id = up.user_id
GROUP BY
  CASE
    WHEN rn BETWEEN  1 AND  5 THEN 'A: 온보딩'
    WHEN rn BETWEEN  6 AND 10 THEN 'B: 우수'
    WHEN rn BETWEEN 11 AND 15 THEN 'C: 평균'
    WHEN rn BETWEEN 16 AND 20 THEN 'D: 휴식'
    WHEN rn BETWEEN 21 AND 25 THEN 'E: 실패'
    WHEN rn BETWEEN 26 AND 30 THEN 'F: 졸업직전'
  END
ORDER BY "그룹";


-- ═══════════════════════════════════════════════════════════════════════
-- V-5. 특수 상태 사용자 확인
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  up.display_name,
  up.organization_slug AS org,
  up.growth_status,
  up.activity_started_at::date AS started,
  up.activity_ended_at::date AS ended,
  ugs.approved_weeks AS approved,
  ugs.cumulative_weeks AS cumulative
FROM public.user_profiles up
LEFT JOIN public.user_growth_stats ugs ON ugs.user_id = up.user_id
WHERE up.growth_status IN ('weekly_rest', 'seasonal_rest', 'paused', 'graduated', 'suspended')
ORDER BY
  CASE up.growth_status
    WHEN 'weekly_rest'    THEN 1
    WHEN 'seasonal_rest'  THEN 2
    WHEN 'paused'         THEN 3
    WHEN 'graduated'      THEN 4
    WHEN 'suspended'      THEN 5
  END;
