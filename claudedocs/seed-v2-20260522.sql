-- ============================================================
-- Seed SQL v2: 30명 더미 사용자 (batch_id = '2026-05-22_seed_30users_v1')
-- ============================================================
-- 작성일: 2026-05-22
-- v1 대비 변경사항:
--   (1) 조직 배정 A'안 확정: oranke 20 + encre 10 + phalanx 0
--   (2) seasons.is_current 컬럼 부재 확인 → target_season CTE (ended_at IS NULL 우선)
--   (3) weeks.week_number 컬럼 부재 → week_index 사용
--   (4) target_season / target_weeks CTE 패턴 적용 (사용자 제시)
--
-- 적용 환경: Supabase SQL Editor (prod 또는 staging) — service_role 권한 필요
-- 적용 전 필수:
--   - seed-step1-prereq-verification-20260522.sql 의 Q1~Q15 실행
--   - Q7 (조직별 실사용자 분포) 가 phalanx 34 / encre 0 / oranke 0 인지 확인
--   - Q8 (식별자 충돌) 모두 0 인지 확인
--   - Q10 (컬럼 구조 dump) 결과로 NOT NULL 컬럼 보정 (특히 Phase 5+)
-- ============================================================

-- ============================================================
-- ★ Phase 0: Pre-flight 시즌/주차 확정 (CONFIRM ONLY — 적용 SQL 아님)
-- ============================================================
-- 다음 쿼리로 "어떤 시즌을 사용할지" 확인 후 Phase 2 진행
-- 결과의 season_id 가 Cluster4 모든 활동의 기준이 됨
SELECT
  id AS target_season_id,
  season_index,
  name,
  started_at,
  ended_at,
  (ended_at IS NULL) AS is_open_season,
  (
    SELECT COUNT(*) FROM public.weeks w WHERE w.season_id = s.id
  ) AS week_count
FROM public.seasons s
ORDER BY
  CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
  started_at DESC,
  season_index DESC
LIMIT 3;
-- ⚠️ 1순위 row 가 의도한 시즌과 다르면 Phase 2 적용 중단 후 정책 재검토.


-- ============================================================
-- ★ Phase 1: test_user_markers 마커 테이블 신설 (idempotent)
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.test_user_markers (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  seed_batch_id text NOT NULL,
  user_type text,                       -- newbie | normal | high_activity | admin | status_issue
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS test_user_markers_batch_idx
  ON public.test_user_markers(seed_batch_id);

-- 마커 테이블 권한: anon/authenticated 는 SELECT 만, write 는 service_role 만
-- (현재 RLS 미적용 — 필요 시 별도 정책 추가)

COMMIT;


-- ============================================================
-- ★ Phase 2: auth.users + user_profiles (FK 루트)
-- ============================================================
-- ⚠️ auth.users 생성 방식 선택:
--   (A) Supabase Auth admin API 호출 (권장) — TypeScript/Node 스크립트로 30회
--       → 트리거·해시·refresh_token·identities 자동 처리
--   (B) 직접 SQL INSERT INTO auth.users — 본 SQL 의 방식
--       → pgcrypto + bcrypt + email_confirmed_at 직접 설정 필요
--       → ⚠️ Supabase 가 향후 컬럼 구조 변경 시 호환성 깨질 수 있음
--
-- 본 SQL 은 (B) 방식. (A) 사용 시 Phase 2 의 auth.users INSERT 부분을 스크립트로 교체.

BEGIN;

-- Seed 데이터 임시 테이블 (idx → 필드 매핑)
CREATE TEMP TABLE seed_users AS
WITH gen AS (
  SELECT gs.idx FROM generate_series(1, 30) AS gs(idx)
)
SELECT
  gen.idx,
  gen_random_uuid() AS user_uuid,
  900000 + gen.idx AS legacy_id,
  'dummy' || lpad(gen.idx::text, 2, '0') || '@vraxium.test' AS email,
  '[TEST] 더미크루' || lpad(gen.idx::text, 2, '0') AS display_name,
  '010-9900-' || lpad(gen.idx::text, 4, '0') AS phone,
  CASE
    WHEN gen.idx BETWEEN 1 AND 6 THEN 'newbie'
    WHEN gen.idx BETWEEN 7 AND 18 THEN 'normal'
    WHEN gen.idx BETWEEN 19 AND 26 THEN 'high_activity'
    WHEN gen.idx BETWEEN 27 AND 28 THEN 'admin'
    ELSE 'status_issue'
  END AS user_type,
  -- 조직 분배: oranke 20명 / encre 10명 / phalanx 0명
  -- oranke idx: 1-4(신입 4), 7-14(일반 8), 19-24(고활동 6), 27(운영진 1), 29(상태 1) = 20
  -- encre  idx: 5-6(신입 2), 15-18(일반 4), 25-26(고활동 2), 28(운영진 1), 30(상태 1) = 10
  CASE
    WHEN gen.idx IN (1,2,3,4, 7,8,9,10,11,12,13,14, 19,20,21,22,23,24, 27, 29) THEN 'oranke'
    ELSE 'encre'
  END AS org_slug,
  CASE WHEN gen.idx % 2 = 1 THEN '남' ELSE '여' END AS gender,
  -- birth_date: 2001-{mm}-{dd} (mm 1~12, dd 1~28)
  '2001-' || lpad(((gen.idx % 12) + 1)::text, 2, '0') || '-' || lpad(((gen.idx % 28) + 1)::text, 2, '0') AS birth_date,
  -- school / department 라운드 로빈
  (ARRAY['서울대','연세대','고려대','카이스트','포스텍','한양대','서강대','성균관대'])[((gen.idx - 1) % 8) + 1] AS school,
  (ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어학과','전자공학과','심리학과'])[((gen.idx - 1) % 6) + 1] AS department,
  -- status: 29번 weekly_rest, 30번 graduated, 나머지 active
  CASE
    WHEN gen.idx = 29 THEN 'weekly_rest'
    WHEN gen.idx = 30 THEN 'graduated'
    ELSE 'active'
  END AS status_value,
  -- team / part / level
  (ARRAY['브랜딩','기획','미디어','신입'])[((gen.idx - 1) % 4) + 1] AS team_name,
  CASE
    WHEN gen.idx BETWEEN 1 AND 6 THEN '신입'
    WHEN gen.idx BETWEEN 27 AND 28 THEN 'admin'
    WHEN gen.idx BETWEEN 19 AND 26 THEN '심화'
    ELSE '일반'
  END AS part_name,
  CASE
    WHEN gen.idx BETWEEN 27 AND 28 THEN '운영진'
    WHEN gen.idx BETWEEN 19 AND 26 THEN '심화'
    ELSE '일반'
  END AS membership_level
FROM gen;


-- 2-A: auth.users INSERT
-- ⚠️ Q14 (auth.users 컬럼 구조) 결과로 컬럼 목록 확정 필요
-- 본 SQL 은 Supabase 표준 컬럼 가정
INSERT INTO auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  is_sso_user
)
SELECT
  su.user_uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  su.email,
  crypt('TestSeed!2026', gen_salt('bf')),
  now(),
  now() - INTERVAL '60 days',
  now(),
  'authenticated',
  'authenticated',
  jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
  jsonb_build_object(
    'seed_batch_id', '2026-05-22_seed_30users_v1',
    'user_type', su.user_type,
    'is_test_user', true
  ),
  false,
  false
FROM seed_users su;

-- 2-B: user_profiles INSERT
-- ⚠️ Q10 결과로 NOT NULL 컬럼 확인 필요. growth_status, profile_photo_url 등은 NULL 가정.
INSERT INTO public.user_profiles (
  user_id,
  legacy_user_id,
  display_name,
  gender,
  birth_date,
  contact_phone,
  contact_email,
  auth_email,
  school_name,
  department_name,
  address,
  organization_slug,
  status,
  created_at,
  updated_at
)
SELECT
  su.user_uuid,
  su.legacy_id,
  su.display_name,
  su.gender,
  su.birth_date,
  su.phone,
  su.email,
  su.email,
  su.school,
  su.department,
  '서울시 성북구 (TEST)',
  su.org_slug,
  su.status_value,
  now() - INTERVAL '60 days',
  now()
FROM seed_users su;

COMMIT;


-- ============================================================
-- ★ Phase 3: 1:1 보조 테이블 (live-DB only 컬럼 — Q10 결과로 보정 필요)
-- ============================================================
BEGIN;

-- user_memberships
-- ⚠️ Q10 결과로 PK 정의 (composite?), NOT NULL 컬럼, joined_at 등 timestamps 컬럼 확인 필요
INSERT INTO public.user_memberships (
  user_id, team_name, part_name, membership_level, membership_state, is_current
)
SELECT
  up.user_id,
  (ARRAY['브랜딩','기획','미디어','신입'])[((up.legacy_user_id - 900000 - 1) % 4) + 1],
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN '신입'
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 'admin'
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN '심화'
    ELSE '일반'
  END,
  CASE
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN '운영진'
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN '심화'
    ELSE '일반'
  END,
  up.status,
  true
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- user_cumulative_points (Shield 기본값 Olympus = 5)
INSERT INTO public.user_cumulative_points (user_id, total_stars, total_shields, total_lightnings)
SELECT
  up.user_id,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 30)::int
    WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 20 + floor(random() * 50)::int
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 60 + floor(random() * 60)::int
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 80 + floor(random() * 70)::int
    ELSE 30 + floor(random() * 50)::int
  END,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN 5
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 5
    ELSE 3 + floor(random() * 3)::int
  END,
  floor(random() * 10)::int
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- user_growth_stats
INSERT INTO public.user_growth_stats (user_id, cumulative_weeks, approved_weeks)
SELECT
  up.user_id,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 4)::int
    WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 4 + floor(random() * 5)::int
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 9 + floor(random() * 6)::int
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 12 + floor(random() * 5)::int
    ELSE 5 + floor(random() * 6)::int
  END,
  GREATEST(
    0,
    CASE
      WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 3)::int
      WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 3 + floor(random() * 5)::int
      WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 8 + floor(random() * 6)::int
      WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 10 + floor(random() * 5)::int
      ELSE 4 + floor(random() * 5)::int
    END
  )
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- applicants (kakao 가입 승인 완료)
INSERT INTO public.applicants (
  email, name, provider, status, linked_user_id, reviewed_at, created_at, updated_at
)
SELECT
  up.auth_email,
  up.display_name,
  'kakao',
  'approved',
  up.user_id,
  now() - INTERVAL '30 days',
  now() - INTERVAL '60 days',
  now()
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- admin_users (운영진 2명만 — legacy 900027, 900028)
INSERT INTO public.admin_users (id, email, role, is_active, updated_at)
SELECT
  up.user_id,
  up.auth_email,
  CASE WHEN up.legacy_user_id = 900027 THEN 'owner' ELSE 'admin' END,
  true,
  now()
FROM public.user_profiles up
WHERE up.legacy_user_id IN (900027, 900028);

COMMIT;


-- ============================================================
-- ★ Phase 4: 식별 마커 기록 + 검증
-- ============================================================
BEGIN;

INSERT INTO public.test_user_markers (user_id, seed_batch_id, user_type, note)
SELECT
  up.user_id,
  '2026-05-22_seed_30users_v1',
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN 'newbie'
    WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 'normal'
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 'high_activity'
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 'admin'
    ELSE 'status_issue'
  END,
  'Created by seed-v2 design (organization=' || up.organization_slug || ', legacy_id=' || up.legacy_user_id || ')'
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;


-- ★ Phase 4 검증: row count + 조직 분포 + phalanx 무영향
DO $$
DECLARE
  marker_count int;
  profile_count int;
  oranke_count int;
  encre_count int;
  phalanx_dummy_count int;
  auth_count int;
BEGIN
  SELECT COUNT(*) INTO marker_count
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO profile_count
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030;

  SELECT COUNT(*) INTO oranke_count
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030
    AND organization_slug = 'oranke';

  SELECT COUNT(*) INTO encre_count
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030
    AND organization_slug = 'encre';

  SELECT COUNT(*) INTO phalanx_dummy_count
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030
    AND organization_slug = 'phalanx';

  SELECT COUNT(*) INTO auth_count
  FROM auth.users
  WHERE lower(email) LIKE '%@vraxium.test';

  IF marker_count <> 30 THEN
    RAISE EXCEPTION 'marker_count=% (30 이어야 함)', marker_count;
  END IF;
  IF profile_count <> 30 THEN
    RAISE EXCEPTION 'profile_count=% (30 이어야 함)', profile_count;
  END IF;
  IF oranke_count <> 20 THEN
    RAISE EXCEPTION 'oranke_count=% (20 이어야 함)', oranke_count;
  END IF;
  IF encre_count <> 10 THEN
    RAISE EXCEPTION 'encre_count=% (10 이어야 함)', encre_count;
  END IF;
  IF phalanx_dummy_count <> 0 THEN
    RAISE EXCEPTION 'phalanx_dummy_count=% (0 이어야 함 — 실사용자 격리 위배)', phalanx_dummy_count;
  END IF;
  IF auth_count <> 30 THEN
    RAISE EXCEPTION 'auth_count=% (30 이어야 함)', auth_count;
  END IF;

  RAISE NOTICE 'Phase 4 검증 통과: markers=%, profiles=%, oranke=%, encre=%, phalanx_dummy=%, auth=%',
    marker_count, profile_count, oranke_count, encre_count, phalanx_dummy_count, auth_count;
END $$;

COMMIT;


-- ============================================================
-- ★ Phase 5~7: Cluster2~4 콘텐츠 (Q10 결과 받은 후 작성)
-- ============================================================
-- Phase 5 (Cluster2): user_cluster2, user_introductions, user_educations,
--                     user_resume_card_settings, user_review_links
-- Phase 6 (Cluster3): portfolio_top_cards, portfolio_channel_cards
-- Phase 7 (Cluster4): user_activity_details, weekly_reviews, weekly_colleagues,
--                     weekly_reputations, user_season_histories, season_reputations, career_records
--
-- Cluster4 적용 시 target_season / target_weeks CTE 사용:
/*
WITH target_season AS (
  SELECT id
  FROM public.seasons
  ORDER BY
    CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
    started_at DESC,
    season_index DESC
  LIMIT 1
),
target_weeks AS (
  SELECT id AS week_id, week_index
  FROM public.weeks
  WHERE season_id = (SELECT id FROM target_season)
  ORDER BY week_index
),
target_user_pool AS (
  SELECT up.user_id, up.legacy_user_id,
    CASE
      WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN 'newbie'
      WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 'normal'
      WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 'high_activity'
      WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 'admin'
      ELSE 'status_issue'
    END AS user_type
  FROM public.user_profiles up
  WHERE up.legacy_user_id BETWEEN 900001 AND 900030
)
-- user_activity_details, weekly_reviews, weekly_colleagues 등에서 위 CTE 활용
INSERT INTO public.user_activity_details (
  user_id, week_id, activity_type_id, sub_title, ...
)
SELECT
  tup.user_id,
  tw.week_id,
  '<activity_type_id from activity_types>',
  '[TEST] 활동 ' || tw.week_index || '주차',
  ...
FROM target_user_pool tup
CROSS JOIN target_weeks tw
WHERE
  -- 유형별 활동 주차 선택 규칙
  (tup.user_type = 'newbie' AND tw.week_index <= 3)
  OR (tup.user_type = 'normal' AND tw.week_index <= 8)
  OR (tup.user_type IN ('high_activity', 'admin') AND tw.week_index <= 14);
*/


-- ============================================================
-- 적용 후 권장 검증 SQL (seed-30-dummy-users-design 의 §11 참조)
-- ============================================================
-- 1. phalanx 실사용자 row count + checksum baseline 비교
-- 2. encre / oranke 실사용자 checksum 비교 (둘 다 0 가정)
-- 3. updated_at 변화 탐지 (recently_updated_count = 0 이어야)
-- 4. peer-review 교차 오염 (leak_count = 0 이어야)
-- 5. legacy_user_id 대역 격리 (dummy_range = 30)
