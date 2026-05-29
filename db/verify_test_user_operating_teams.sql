-- Verify TEST user memberships against the operating allow-list.
-- Scope: seed_batch_id = '2026-05-26_seed_90users_v2'
-- This intentionally does not validate against cluster4_teams.

WITH allowed_teams AS (
  SELECT *
  FROM (
    VALUES
      ('encre', '갤러리', 1),
      ('encre', '비주얼', 2),
      ('encre', '팬마케팅', 3),
      ('encre', '프로듀싱', 4),
      ('encre', 'A&R', 5),
      ('oranke', '스타일', 1),
      ('oranke', '엔터테인먼트', 2),
      ('oranke', '커머스', 3),
      ('oranke', '콘텐츠', 4),
      ('oranke', 'F&B', 5),
      ('oranke', '신입', 6),
      ('phalanx', '브랜딩', 1),
      ('phalanx', '서비스', 2),
      ('phalanx', 'IT', 3)
  ) AS t(organization_slug, team_name, sort_order)
),
target_users AS (
  SELECT
    tm.legacy_user_id,
    tm.user_id,
    up.display_name,
    up.organization_slug,
    um.id AS membership_id,
    um.team_name,
    COALESCE(ugs.cumulative_weeks, 0) AS cumulative_weeks,
    COALESCE(ugs.approved_weeks, 0) AS approved_weeks
  FROM public.test_user_markers tm
  JOIN public.user_profiles up
    ON up.user_id = tm.user_id
  JOIN public.user_memberships um
    ON um.user_id = tm.user_id
   AND um.is_current IS NOT FALSE
  LEFT JOIN public.user_growth_stats ugs
    ON ugs.user_id = tm.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
),
classified AS (
  SELECT
    tu.*,
    CASE
      WHEN at.team_name IS NOT NULL
       AND tu.team_name <> '신입' THEN 'OK_ALLOWED_TEAM'
      WHEN tu.organization_slug = 'oranke'
       AND tu.team_name = '신입'
       AND tu.cumulative_weeks = 0
       AND tu.approved_weeks = 0 THEN 'OK_NEWBIE_ZERO_WEEKS'
      ELSE 'INVALID'
    END AS validation_status
  FROM target_users tu
  LEFT JOIN allowed_teams at
    ON at.organization_slug = tu.organization_slug
   AND at.team_name = tu.team_name
)
SELECT
  COUNT(*) FILTER (WHERE validation_status = 'INVALID') AS invalid_count,
  COUNT(*) AS checked_count
FROM classified;

-- Optional detail query for rows that fail the same validation.
WITH allowed_teams AS (
  SELECT *
  FROM (
    VALUES
      ('encre', '갤러리', 1),
      ('encre', '비주얼', 2),
      ('encre', '팬마케팅', 3),
      ('encre', '프로듀싱', 4),
      ('encre', 'A&R', 5),
      ('oranke', '스타일', 1),
      ('oranke', '엔터테인먼트', 2),
      ('oranke', '커머스', 3),
      ('oranke', '콘텐츠', 4),
      ('oranke', 'F&B', 5),
      ('oranke', '신입', 6),
      ('phalanx', '브랜딩', 1),
      ('phalanx', '서비스', 2),
      ('phalanx', 'IT', 3)
  ) AS t(organization_slug, team_name, sort_order)
),
classified AS (
  SELECT
    tm.legacy_user_id,
    tm.user_id,
    up.display_name,
    up.organization_slug,
    um.team_name,
    COALESCE(ugs.cumulative_weeks, 0) AS cumulative_weeks,
    COALESCE(ugs.approved_weeks, 0) AS approved_weeks,
    CASE
      WHEN at.team_name IS NOT NULL
       AND um.team_name <> '신입' THEN 'OK_ALLOWED_TEAM'
      WHEN up.organization_slug = 'oranke'
       AND um.team_name = '신입'
       AND COALESCE(ugs.cumulative_weeks, 0) = 0
       AND COALESCE(ugs.approved_weeks, 0) = 0 THEN 'OK_NEWBIE_ZERO_WEEKS'
      ELSE 'INVALID'
    END AS validation_status
  FROM public.test_user_markers tm
  JOIN public.user_profiles up
    ON up.user_id = tm.user_id
  JOIN public.user_memberships um
    ON um.user_id = tm.user_id
   AND um.is_current IS NOT FALSE
  LEFT JOIN public.user_growth_stats ugs
    ON ugs.user_id = tm.user_id
  LEFT JOIN allowed_teams at
    ON at.organization_slug = up.organization_slug
   AND at.team_name = um.team_name
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
)
SELECT *
FROM classified
WHERE validation_status = 'INVALID'
ORDER BY organization_slug, legacy_user_id;
