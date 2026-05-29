-- TEST 90 users team/organization audit and deterministic repair.
-- Scope: seed_batch_id = '2026-05-26_seed_90users_v2'
-- Note: current user_memberships stores team_name, not team_id. team_id below is
-- resolved from public.cluster4_teams by team_name.

-- 1. Current 90-user mapping.
SELECT
  tm.legacy_user_id,
  up.user_id,
  up.display_name,
  up.organization_slug,
  ct.id AS team_id,
  um.team_name,
  ct.organization_slug AS team_organization_slug,
  CASE
    WHEN ct.id IS NULL THEN 'TEAM_NOT_FOUND'
    WHEN up.organization_slug = ct.organization_slug THEN 'OK'
    ELSE 'MISMATCH'
  END AS status
FROM public.test_user_markers tm
JOIN public.user_profiles up ON up.user_id = tm.user_id
JOIN public.user_memberships um ON um.user_id = tm.user_id
LEFT JOIN public.cluster4_teams ct ON ct.team_name = um.team_name
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
  AND um.is_current IS NOT FALSE
ORDER BY tm.legacy_user_id;

-- 2. Operating team list by organization.
SELECT organization_slug, id AS team_id, team_name, is_active
FROM public.cluster4_teams
WHERE organization_slug IN ('encre', 'oranke', 'phalanx')
ORDER BY
  organization_slug,
  CASE organization_slug
    WHEN 'encre' THEN array_position(ARRAY['갤러리','비주얼','팬마케팅','프로듀싱','A&R'], team_name)
    WHEN 'oranke' THEN array_position(ARRAY['스타일','엔터테인먼트','커머스','콘텐츠','F&B'], team_name)
    WHEN 'phalanx' THEN array_position(ARRAY['브랜딩','서비스','IT'], team_name)
  END NULLS LAST,
  team_name;

-- 3. Mismatch count.
SELECT
  COUNT(*) AS total_test_users,
  COUNT(*) FILTER (WHERE ct.id IS NULL) AS team_not_found,
  COUNT(*) FILTER (WHERE up.organization_slug = ct.organization_slug) AS matched_users,
  COUNT(*) FILTER (WHERE up.organization_slug IS DISTINCT FROM ct.organization_slug) AS mismatched_users
FROM public.test_user_markers tm
JOIN public.user_profiles up ON up.user_id = tm.user_id
JOIN public.user_memberships um ON um.user_id = tm.user_id
LEFT JOIN public.cluster4_teams ct ON ct.team_name = um.team_name
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
  AND um.is_current IS NOT FALSE;

-- 4. Mismatch user list with deterministic target team preview.
WITH mismatched_users AS (
  SELECT
    tm.legacy_user_id,
    tm.user_id,
    up.display_name,
    up.organization_slug,
    ct.id AS current_team_id,
    um.team_name AS current_team_name,
    ct.organization_slug AS current_team_org,
    row_number() OVER (
      PARTITION BY up.organization_slug
      ORDER BY tm.legacy_user_id
    ) - 1 AS user_idx
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  JOIN public.user_memberships um ON um.user_id = tm.user_id
  LEFT JOIN public.cluster4_teams ct ON ct.team_name = um.team_name
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.is_current IS NOT FALSE
    AND up.organization_slug IS DISTINCT FROM ct.organization_slug
),
org_teams AS (
  SELECT
    organization_slug,
    id AS target_team_id,
    team_name AS target_team_name,
    row_number() OVER (
      PARTITION BY organization_slug
      ORDER BY
        CASE organization_slug
          WHEN 'encre' THEN array_position(ARRAY['갤러리','비주얼','팬마케팅','프로듀싱','A&R'], team_name)
          WHEN 'oranke' THEN array_position(ARRAY['스타일','엔터테인먼트','커머스','콘텐츠','F&B'], team_name)
          WHEN 'phalanx' THEN array_position(ARRAY['브랜딩','서비스','IT'], team_name)
        END NULLS LAST,
        team_name,
        id
    ) - 1 AS team_idx,
    count(*) OVER (PARTITION BY organization_slug) AS team_count
  FROM public.cluster4_teams
  WHERE organization_slug IN ('encre', 'oranke', 'phalanx')
    AND is_active IS NOT FALSE
)
SELECT
  mu.legacy_user_id,
  mu.user_id,
  mu.display_name,
  mu.organization_slug,
  mu.current_team_id,
  mu.current_team_name,
  mu.current_team_org,
  ot.target_team_id,
  ot.target_team_name
FROM mismatched_users mu
JOIN org_teams ot
  ON ot.organization_slug = mu.organization_slug
 AND ot.team_idx = (mu.user_idx % ot.team_count)
ORDER BY mu.legacy_user_id;

-- 5. UPDATE SQL.
-- Deterministic rule:
--   For each mismatched organization, order users by legacy_user_id and assign
--   round-robin over active teams that actually belong to the same
--   cluster4_teams.organization_slug. No random function is used.
BEGIN;

WITH mismatched_users AS (
  SELECT
    tm.user_id,
    up.organization_slug,
    row_number() OVER (
      PARTITION BY up.organization_slug
      ORDER BY tm.legacy_user_id
    ) - 1 AS user_idx
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  JOIN public.user_memberships um ON um.user_id = tm.user_id
  LEFT JOIN public.cluster4_teams ct ON ct.team_name = um.team_name
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.is_current IS NOT FALSE
    AND up.organization_slug IS DISTINCT FROM ct.organization_slug
),
org_teams AS (
  SELECT
    organization_slug,
    team_name AS target_team_name,
    row_number() OVER (
      PARTITION BY organization_slug
      ORDER BY
        CASE organization_slug
          WHEN 'encre' THEN array_position(ARRAY['갤러리','비주얼','팬마케팅','프로듀싱','A&R'], team_name)
          WHEN 'oranke' THEN array_position(ARRAY['스타일','엔터테인먼트','커머스','콘텐츠','F&B'], team_name)
          WHEN 'phalanx' THEN array_position(ARRAY['브랜딩','서비스','IT'], team_name)
        END NULLS LAST,
        team_name,
        id
    ) - 1 AS team_idx,
    count(*) OVER (PARTITION BY organization_slug) AS team_count
  FROM public.cluster4_teams
  WHERE organization_slug IN ('encre', 'oranke', 'phalanx')
    AND is_active IS NOT FALSE
),
assignments AS (
  SELECT mu.user_id, ot.target_team_name
  FROM mismatched_users mu
  JOIN org_teams ot
    ON ot.organization_slug = mu.organization_slug
   AND ot.team_idx = (mu.user_idx % ot.team_count)
)
UPDATE public.user_memberships um
SET team_name = assignments.target_team_name
FROM assignments
WHERE um.user_id = assignments.user_id
  AND um.is_current IS NOT FALSE;

-- Check the affected row count in your SQL client. Expected: 60.
COMMIT;

-- 6. Post-update verification SQL. Expected mismatched_users = 0.
SELECT
  COUNT(*) AS total_test_users,
  COUNT(*) FILTER (WHERE ct.id IS NULL) AS team_not_found,
  COUNT(*) FILTER (WHERE up.organization_slug = ct.organization_slug) AS matched_users,
  COUNT(*) FILTER (WHERE up.organization_slug IS DISTINCT FROM ct.organization_slug) AS mismatched_users
FROM public.test_user_markers tm
JOIN public.user_profiles up ON up.user_id = tm.user_id
JOIN public.user_memberships um ON um.user_id = tm.user_id
LEFT JOIN public.cluster4_teams ct ON ct.team_name = um.team_name
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
  AND um.is_current IS NOT FALSE;
