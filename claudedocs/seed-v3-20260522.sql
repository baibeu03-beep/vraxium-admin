-- ============================================================
-- 🔴 DEPRECATED (2026-05-22) — Seed SQL v3 사용 중단
-- 최신: seed-v4-20260522.sql
--
-- v3 폐기 사유:
--   user_profiles.user_id 가 auth.users(id) 가 아니라 public.users(id) FK 참조
--   → auth.users 만 생성해서는 user_profiles INSERT 불가
--   → v4 에서 public.users INSERT 먼저 + auth.users 는 보류
-- ============================================================
-- (이하 v3 SQL 은 historical reference. 실행 금지)
-- ============================================================
-- Seed SQL v3 (FINAL): 30명 더미 사용자
-- batch_id = '2026-05-22_seed_30users_v1'
-- ============================================================
-- 작성일: 2026-05-22
-- 상태: FINAL — user_profiles 실제 컬럼 17종 확정 반영
--
-- 확정된 user_profiles 컬럼 (2026-05-22 사용자 보고):
--   user_id, display_name, birth_date, gender, contact_phone, contact_email,
--   status, growth_status, organization_slug, school_name, department_name,
--   address, auth_email, contact_available, role, created_at, updated_at,
--   profile_photo_url, vision
--   (legacy_user_id 부재 확정 — test_user_markers 에만 저장)
--
-- v2 → v3 변경 누계:
--   (1) user_profiles.legacy_user_id 컬럼 부재 → user_profiles 에서 제외
--   (2) legacy_user_id 는 test_user_markers (bigint NOT NULL UNIQUE) 에만 저장
--   (3) seasons.is_current 컬럼 부재 → ended_at IS NULL 우선 + season_index DESC
--   (4) weeks.week_number 컬럼 부재 → week_index 사용
--   (5) 모든 검증·rollback 에서 user_profiles 대신 test_user_markers JOIN 패턴
--   (6) Phase 1 안전 가드: 구버전 마커 테이블 row=0 검증 후 DROP/재생성
--
-- 적용 환경: Supabase SQL Editor (prod 또는 staging) — service_role 권한 필요
-- 적용 전 통과 확인됨 (2026-05-22):
--   - Q7 (조직별 실사용자): phalanx 34 / encre 0 / oranke 0
--   - Q8a (marker_schema): -1 (구버전 잔존) — Phase 1 자동 DROP 안전
--   - Q18 (구버전 marker_rows): 0 — DROP 안전
--   - Q16 (user_profiles 컬럼): 17종 확정
-- ============================================================


-- ============================================================
-- ★ Phase 0: Pre-flight 시즌 확인 (READ ONLY — 사전 검토용)
-- ============================================================
-- 1순위 row 가 의도한 시즌인지 확인 후 Phase 1 진행
SELECT
  id AS target_season_id,
  season_index,
  name,
  started_at,
  ended_at,
  (ended_at IS NULL) AS is_open_season,
  (SELECT COUNT(*) FROM public.weeks w WHERE w.season_id = s.id) AS week_count
FROM public.seasons s
ORDER BY
  CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
  started_at DESC,
  season_index DESC
LIMIT 3;
-- ⚠️ 1순위 row 가 의도와 다르면 Phase 1 적용 중단 후 정책 재검토.


-- ============================================================
-- ★ Phase 1: test_user_markers 재생성 (v2 잔여 마커 안전 정리)
-- ============================================================
BEGIN;

-- 1-A: 구버전 마커 테이블 안전 검증 + DROP
DO $$
DECLARE
  old_row_count int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname='public' AND tablename='test_user_markers'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM public.test_user_markers' INTO old_row_count;
    IF old_row_count > 0 THEN
      RAISE EXCEPTION 'test_user_markers row=% 존재. 수동 검토 필요 (DROP 차단).', old_row_count;
    END IF;
    RAISE NOTICE 'v2 잔여 test_user_markers (row=0) 안전 DROP 진행';
  END IF;
END $$;

DROP TABLE IF EXISTS public.test_user_markers CASCADE;


-- 1-B: v3 test_user_markers 생성 (사용자 권장 구조)
CREATE TABLE public.test_user_markers (
  user_id        uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  seed_batch_id  text NOT NULL,
  legacy_user_id bigint NOT NULL,
  user_type      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  note           text
);

CREATE UNIQUE INDEX test_user_markers_legacy_user_id_idx
  ON public.test_user_markers(legacy_user_id);

CREATE INDEX test_user_markers_batch_idx
  ON public.test_user_markers(seed_batch_id);

COMMENT ON COLUMN public.test_user_markers.user_type IS
  'newbie | normal | high_activity | admin | status_issue';

COMMIT;


-- ============================================================
-- ★ Phase 2: auth.users + user_profiles
-- ============================================================
BEGIN;

-- 2-A: Seed 데이터 임시 테이블 (idx → 필드 매핑 통합)
CREATE TEMP TABLE seed_users AS
WITH gen AS (
  SELECT gs.idx FROM generate_series(1, 30) AS gs(idx)
)
SELECT
  gen.idx,
  gen_random_uuid() AS user_uuid,
  (900000 + gen.idx)::bigint AS legacy_id,
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
  -- 조직 분배: oranke 20 / encre 10 / phalanx 0
  --   oranke idx: 1-4(신입 4), 7-14(일반 8), 19-24(고활동 6), 27(운영진 1), 29(상태 1) = 20
  --   encre  idx: 5-6(신입 2), 15-18(일반 4), 25-26(고활동 2), 28(운영진 1), 30(상태 1) = 10
  CASE
    WHEN gen.idx IN (1,2,3,4, 7,8,9,10,11,12,13,14, 19,20,21,22,23,24, 27, 29) THEN 'oranke'
    ELSE 'encre'
  END AS org_slug,
  CASE WHEN gen.idx % 2 = 1 THEN '남' ELSE '여' END AS gender,
  -- birth_date: user_profiles.birth_date 가 date 타입 — 처음부터 date 로 생성 (사용자 권장)
  make_date(
    2001,
    ((gen.idx % 12) + 1),
    ((gen.idx % 28) + 1)
  ) AS birth_date,
  (ARRAY['서울대','연세대','고려대','카이스트','포스텍','한양대','서강대','성균관대'])[((gen.idx - 1) % 8) + 1] AS school,
  (ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어학과','전자공학과','심리학과'])[((gen.idx - 1) % 6) + 1] AS department,
  CASE
    WHEN gen.idx = 29 THEN 'weekly_rest'
    WHEN gen.idx = 30 THEN 'graduated'
    ELSE 'active'
  END AS status_value
FROM gen;


-- 2-B: auth.users INSERT
-- ⚠️ Q14 결과로 컬럼 보정 가능. 본 SQL 은 Supabase 표준 컬럼 가정.
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
    'legacy_user_id', su.legacy_id,
    'user_type', su.user_type,
    'is_test_user', true
  ),
  false,
  false
FROM seed_users su;


-- 2-C: user_profiles INSERT (확정 17 컬럼 — legacy_user_id 제외)
-- 사용자 확정 컬럼 순서대로:
INSERT INTO public.user_profiles (
  user_id,
  display_name,
  birth_date,
  gender,
  contact_phone,
  contact_email,
  status,
  growth_status,
  organization_slug,
  school_name,
  department_name,
  address,
  auth_email,
  contact_available,
  role,
  created_at,
  updated_at
)
SELECT
  su.user_uuid,
  su.display_name,
  su.birth_date,
  su.gender,
  su.phone,
  su.email,
  su.status_value,
  NULL,                            -- growth_status (system-managed, 더미는 NULL)
  su.org_slug,
  su.school,
  su.department,
  '서울시 성북구 (TEST)',
  su.email,                        -- auth_email (lowercase 필요 시 lower(su.email))
  NULL,                            -- contact_available (자유 입력, 더미는 NULL)
  NULL,                            -- role (운영진 구분은 admin_users 로, user_profiles.role 정책 미확정)
  now() - INTERVAL '60 days',
  now()
FROM seed_users su;

COMMIT;


-- ============================================================
-- ★ Phase 3: 1:1 보조 테이블 (live-DB only — Q10 결과로 추가 보정 가능)
-- ============================================================

-- 3-A: dummy_user_pool — auth_email 패턴으로 batch 사용자 풀 재추출
-- (seed_users TEMP 는 트랜잭션 종료로 휘발됨 → 별도 풀 재생성)
CREATE TEMP TABLE dummy_user_pool AS
SELECT
  up.user_id,
  up.auth_email,
  up.display_name,
  up.organization_slug,
  up.status,
  (900000 + substring(up.auth_email FROM 'dummy(\d+)@vraxium\.test')::int)::bigint AS legacy_id,
  CASE
    WHEN substring(up.auth_email FROM 'dummy(\d+)@vraxium\.test')::int BETWEEN 1 AND 6 THEN 'newbie'
    WHEN substring(up.auth_email FROM 'dummy(\d+)@vraxium\.test')::int BETWEEN 7 AND 18 THEN 'normal'
    WHEN substring(up.auth_email FROM 'dummy(\d+)@vraxium\.test')::int BETWEEN 19 AND 26 THEN 'high_activity'
    WHEN substring(up.auth_email FROM 'dummy(\d+)@vraxium\.test')::int BETWEEN 27 AND 28 THEN 'admin'
    ELSE 'status_issue'
  END AS user_type
FROM public.user_profiles up
WHERE lower(up.auth_email) LIKE 'dummy%@vraxium.test'
  AND up.display_name LIKE '[TEST] 더미크루%';

-- 풀 검증 (30 row)
DO $$
DECLARE
  pool_count int;
BEGIN
  SELECT COUNT(*) INTO pool_count FROM dummy_user_pool;
  IF pool_count <> 30 THEN
    RAISE EXCEPTION 'dummy_user_pool=% (30 이어야 함). Phase 2 검증 실패.', pool_count;
  END IF;
END $$;


BEGIN;

-- 3-B: user_memberships (live-DB only — Q10 결과로 NOT NULL 보강 필요 시)
INSERT INTO public.user_memberships (
  user_id, team_name, part_name, membership_level, membership_state, is_current
)
SELECT
  dup.user_id,
  (ARRAY['브랜딩','기획','미디어','신입'])[((dup.legacy_id - 900001) % 4)::int + 1],
  CASE dup.user_type
    WHEN 'newbie'        THEN '신입'
    WHEN 'admin'         THEN 'admin'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  CASE dup.user_type
    WHEN 'admin'         THEN '운영진'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  dup.status,
  true
FROM dummy_user_pool dup;

-- 3-C: user_cumulative_points (Olympus Shield default = 5)
INSERT INTO public.user_cumulative_points (user_id, total_stars, total_shields, total_lightnings)
SELECT
  dup.user_id,
  CASE dup.user_type
    WHEN 'newbie'        THEN floor(random() * 30)::int
    WHEN 'normal'        THEN 20 + floor(random() * 50)::int
    WHEN 'high_activity' THEN 60 + floor(random() * 60)::int
    WHEN 'admin'         THEN 80 + floor(random() * 70)::int
    ELSE                      30 + floor(random() * 50)::int  -- status_issue
  END,
  CASE dup.user_type
    WHEN 'newbie' THEN 5
    WHEN 'admin'  THEN 5
    ELSE 3 + floor(random() * 3)::int
  END,
  floor(random() * 10)::int
FROM dummy_user_pool dup;

-- 3-D: user_growth_stats
INSERT INTO public.user_growth_stats (user_id, cumulative_weeks, approved_weeks)
SELECT
  dup.user_id,
  CASE dup.user_type
    WHEN 'newbie'        THEN floor(random() * 4)::int
    WHEN 'normal'        THEN 4 + floor(random() * 5)::int
    WHEN 'high_activity' THEN 9 + floor(random() * 6)::int
    WHEN 'admin'         THEN 12 + floor(random() * 5)::int
    ELSE                      5 + floor(random() * 6)::int
  END,
  GREATEST(0,
    CASE dup.user_type
      WHEN 'newbie'        THEN floor(random() * 3)::int
      WHEN 'normal'        THEN 3 + floor(random() * 5)::int
      WHEN 'high_activity' THEN 8 + floor(random() * 6)::int
      WHEN 'admin'         THEN 10 + floor(random() * 5)::int
      ELSE                      4 + floor(random() * 5)::int
    END
  )
FROM dummy_user_pool dup;

-- 3-E: applicants (kakao 가입 승인 완료)
INSERT INTO public.applicants (
  email, name, provider, status, linked_user_id, reviewed_at, created_at, updated_at
)
SELECT
  dup.auth_email,
  dup.display_name,
  'kakao',
  'approved',
  dup.user_id,
  now() - INTERVAL '30 days',
  now() - INTERVAL '60 days',
  now()
FROM dummy_user_pool dup;

-- 3-F: admin_users (운영진 2명만)
INSERT INTO public.admin_users (id, email, role, is_active, updated_at)
SELECT
  dup.user_id,
  dup.auth_email,
  CASE WHEN dup.legacy_id = 900027 THEN 'owner' ELSE 'admin' END,
  true,
  now()
FROM dummy_user_pool dup
WHERE dup.user_type = 'admin';

COMMIT;


-- ============================================================
-- ★ Phase 4: test_user_markers 기록 + 10중 검증 게이트
-- ============================================================
BEGIN;

INSERT INTO public.test_user_markers (
  user_id, seed_batch_id, legacy_user_id, user_type, note
)
SELECT
  dup.user_id,
  '2026-05-22_seed_30users_v1',
  dup.legacy_id,
  dup.user_type,
  'organization=' || dup.organization_slug
    || ', status=' || dup.status
    || ', email=' || dup.auth_email
FROM dummy_user_pool dup;


-- ★ 10중 검증 게이트
DO $$
DECLARE
  marker_count int;
  profile_count int;
  oranke_count int;
  encre_count int;
  phalanx_dummy_count int;
  auth_count int;
  membership_count int;
  points_count int;
  applicant_count int;
  admin_count int;
BEGIN
  SELECT COUNT(*) INTO marker_count
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO profile_count
  FROM public.user_profiles up
  JOIN public.test_user_markers tm ON tm.user_id = up.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO oranke_count
  FROM public.user_profiles up
  JOIN public.test_user_markers tm ON tm.user_id = up.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
    AND up.organization_slug = 'oranke';

  SELECT COUNT(*) INTO encre_count
  FROM public.user_profiles up
  JOIN public.test_user_markers tm ON tm.user_id = up.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
    AND up.organization_slug = 'encre';

  SELECT COUNT(*) INTO phalanx_dummy_count
  FROM public.user_profiles up
  JOIN public.test_user_markers tm ON tm.user_id = up.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
    AND up.organization_slug = 'phalanx';

  SELECT COUNT(*) INTO auth_count
  FROM auth.users
  WHERE lower(email) LIKE 'dummy%@vraxium.test';

  SELECT COUNT(*) INTO membership_count
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO points_count
  FROM public.user_cumulative_points ucp
  JOIN public.test_user_markers tm ON tm.user_id = ucp.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO applicant_count
  FROM public.applicants a
  JOIN public.test_user_markers tm ON tm.user_id = a.linked_user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO admin_count
  FROM public.admin_users au
  JOIN public.test_user_markers tm ON tm.user_id = au.id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  IF marker_count       <> 30 THEN RAISE EXCEPTION 'marker_count=% (30 이어야 함)', marker_count; END IF;
  IF profile_count      <> 30 THEN RAISE EXCEPTION 'profile_count=% (30 이어야 함)', profile_count; END IF;
  IF oranke_count       <> 20 THEN RAISE EXCEPTION 'oranke_count=% (20 이어야 함)', oranke_count; END IF;
  IF encre_count        <> 10 THEN RAISE EXCEPTION 'encre_count=% (10 이어야 함)', encre_count; END IF;
  IF phalanx_dummy_count <> 0 THEN
    RAISE EXCEPTION 'phalanx_dummy_count=% (0 이어야 함 — 실사용자 격리 위배)', phalanx_dummy_count;
  END IF;
  IF auth_count         <> 30 THEN RAISE EXCEPTION 'auth_count=% (30 이어야 함)', auth_count; END IF;
  IF membership_count   <> 30 THEN RAISE EXCEPTION 'membership_count=% (30 이어야 함)', membership_count; END IF;
  IF points_count       <> 30 THEN RAISE EXCEPTION 'points_count=% (30 이어야 함)', points_count; END IF;
  IF applicant_count    <> 30 THEN RAISE EXCEPTION 'applicant_count=% (30 이어야 함)', applicant_count; END IF;
  IF admin_count        <> 2  THEN RAISE EXCEPTION 'admin_count=% (2 이어야 함)', admin_count; END IF;

  RAISE NOTICE 'Phase 4 검증 통과 (10/10): markers=%, profiles=%, oranke=%, encre=%, phalanx_dummy=%, auth=%, memberships=%, points=%, applicants=%, admins=%',
    marker_count, profile_count, oranke_count, encre_count, phalanx_dummy_count,
    auth_count, membership_count, points_count, applicant_count, admin_count;
END $$;

COMMIT;


-- ============================================================
-- ★ Phase 5~7: Cluster2~4 콘텐츠 (다음 라운드 — Q10 결과 후)
-- ============================================================
-- Phase 5 (Cluster2): user_cluster2, user_introductions, user_educations,
--                     user_resume_card_settings, user_review_links
-- Phase 6 (Cluster3): portfolio_top_cards, portfolio_channel_cards
-- Phase 7 (Cluster4): user_activity_details, weekly_reviews, weekly_colleagues,
--                     weekly_reputations, user_season_histories, season_reputations,
--                     career_records
--
-- Cluster4 적용 시 CTE 템플릿 (v3 최종 — test_user_markers JOIN):
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
  SELECT
    tm.user_id,
    tm.legacy_user_id,
    tm.user_type,
    up.organization_slug,
    up.status
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
)
INSERT INTO public.user_activity_details (
  user_id, week_id, activity_type_id, sub_title, growth_point, rating, ...
)
SELECT
  tup.user_id,
  tw.week_id,
  '<activity_type_id from activity_types>',
  '[TEST] 활동 ' || tw.week_index || '주차',
  '[TEST] 성장 포인트 ' || tw.week_index,
  CASE tup.user_type
    WHEN 'newbie'        THEN 3 + floor(random() * 4)::int
    WHEN 'normal'        THEN 5 + floor(random() * 4)::int
    WHEN 'high_activity' THEN 6 + floor(random() * 5)::int
    WHEN 'admin'         THEN 7 + floor(random() * 4)::int
    ELSE                       4 + floor(random() * 4)::int
  END,
  ...
FROM target_user_pool tup
CROSS JOIN target_weeks tw
WHERE
  (tup.user_type = 'newbie' AND tw.week_index <= 3)
  OR (tup.user_type = 'normal' AND tw.week_index <= 8)
  OR (tup.user_type IN ('high_activity', 'admin') AND tw.week_index <= 14)
  OR (tup.user_type = 'status_issue' AND tw.week_index <= 10);
*/


-- ============================================================
-- 적용 후 권장 검증 SQL (실사용자 보호 confirm)
-- ============================================================
-- (1) test_user_markers 기준 30명 확인:
--     SELECT seed_batch_id, COUNT(*) FROM public.test_user_markers GROUP BY 1;
--     Expected: '2026-05-22_seed_30users_v1' | 30
--
-- (2) phalanx 실사용자 row count baseline 비교 (Seed 전/후 동일해야):
--     SELECT COUNT(*) FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     WHERE up.organization_slug = 'phalanx' AND tm.user_id IS NULL;
--     Expected: 34 (변경 없음)
--
-- (3) updated_at 변화 탐지 (phalanx 영향 zero 확인):
--     SELECT COUNT(*) FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     WHERE up.organization_slug = 'phalanx'
--       AND up.updated_at >= now() - INTERVAL '10 minutes'
--       AND tm.user_id IS NULL;
--     Expected: 0
--
-- (4) 조직별 dummy/real 분포 dump:
--     SELECT up.organization_slug,
--            COUNT(*) FILTER (WHERE tm.user_id IS NOT NULL) AS dummy_count,
--            COUNT(*) FILTER (WHERE tm.user_id IS NULL) AS real_count
--     FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     GROUP BY up.organization_slug
--     ORDER BY up.organization_slug;
--     Expected:
--       encre   | 10 | 0
--       oranke  | 20 | 0
--       phalanx | 0  | 34
