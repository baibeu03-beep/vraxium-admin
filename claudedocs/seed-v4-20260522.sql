-- ============================================================
-- 🔴 DEPRECATED (2026-05-22) — Seed SQL v4 사용 중단
-- 최신: seed-v4_1-20260522.sql
--
-- v4 폐기 사유:
--   (1) applicants.reviewed_at 컬럼 부재 → approved_at 사용
--   (2) admin_users.id 가 auth.users(id) FK 참조 확인 → admin_users 도 v5 분리
-- ============================================================
-- (이하 v4 SQL 은 historical reference. 실행 금지)
-- ============================================================
-- Seed SQL v4: 30명 더미 사용자 (Cluster1 only)
-- batch_id = '2026-05-22_seed_30users_v1'
-- ============================================================
-- 작성일: 2026-05-22
-- 상태: ACTIVE — public.users 기반 Cluster1 seed 집중
--
-- ★ v3 → v4 핵심 변경:
--   (1) user_profiles.user_id 가 public.users(id) FK 참조 확인됨
--   (2) auth.users 직접 INSERT 제거 (별도 v5 로 분리 — login flow 와 함께)
--   (3) public.users INSERT 추가 (Phase 2 신규)
--   (4) legacy_user_id 를 public.users 와 test_user_markers 양쪽에 명시 저장
--       (synthetic seq 우회 — 900001~900030 대역 보장)
--   (5) 단일 BEGIN/COMMIT 트랜잭션 (사용자 권장)
--   (6) INSERT 순서: public.users → user_profiles → user_memberships
--       → user_cumulative_points → user_growth_stats → applicants
--       → admin_users → test_user_markers
--
-- ★ 확정된 스키마 (2026-05-22 사용자 보고):
--   public.users:
--     id            uuid NOT NULL DEFAULT gen_random_uuid()
--     legacy_user_id bigint NOT NULL DEFAULT nextval('users_legacy_user_id_seq')
--     created_at    timestamptz DEFAULT now()
--     updated_at    timestamptz DEFAULT now()
--   user_profiles (17 컬럼):
--     user_id, display_name, birth_date(date), gender, contact_phone, contact_email,
--     status, growth_status, organization_slug, school_name, department_name,
--     address, auth_email, contact_available, role, created_at, updated_at
--   seasons : id, season_index, name, started_at, ended_at(nullable)
--   weeks   : id, season_id, week_index, started_at, ended_at
--   test_user_markers v3 구조 (이미 존재):
--     user_id PK FK user_profiles, seed_batch_id, legacy_user_id bigint UNIQUE,
--     user_type, created_at, note
--
-- ★ 사전 통과 확인 (2026-05-22):
--   - Q7: phalanx 34 / encre 0 / oranke 0
--   - Q8a: marker_schema = 1 (v3 구조 존재) 또는 -1 (구버전), Q18 row=0
--   - Q16: user_profiles 17 컬럼 (legacy_user_id 없음)
--   - Q19: public.users 4 컬럼
--   - Q20: user_profiles.user_id → public.users(id) FK
--
-- ★ 적용 범위 (v4):
--   ✅ Phase 1-4 (Cluster1 + 마커 기록) — 단일 트랜잭션
--   ❌ auth.users / login flow — v5 (별도)
--   ❌ Cluster2~4 콘텐츠 (user_cluster2, user_introductions, user_educations,
--      user_activity_details, weekly_*, career_*) — Phase 5+ (별도)
-- ============================================================


-- ============================================================
-- ★ Phase 0: Pre-flight (READ ONLY — 사전 검토)
-- ============================================================

-- 0-A: 시즌 확인 (Cluster4 적용 시 사용)
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

-- 0-B: v3 잔여 auth.users 정리 확인 (트랜잭션 rollback 으로 0 이어야)
SELECT
  'auth_users_residue' AS check_name,
  COUNT(*) AS residue_count
FROM auth.users
WHERE lower(email) LIKE 'dummy%@vraxium.test';
-- Expected: 0 (v3 트랜잭션 rollback 으로 자동 정리됨)

-- 0-C: v3 잔여 public.users 정리 확인
SELECT
  'public_users_residue' AS check_name,
  COUNT(*) AS residue_count
FROM public.users
WHERE legacy_user_id BETWEEN 900001 AND 900030;
-- Expected: 0

-- 0-D: test_user_markers 잔여 (Phase 1 idempotent CREATE 가드)
SELECT
  'markers_residue' AS check_name,
  CASE
    WHEN to_regclass('public.test_user_markers') IS NULL THEN 0
    ELSE (SELECT COUNT(*)::int FROM public.test_user_markers)
  END AS residue_count;
-- Expected: 0 (v3 잔여물 row=0 확인됨)


-- ============================================================
-- ★ Phase 1: test_user_markers 테이블 idempotent 생성
-- ============================================================
BEGIN;

-- 구버전 / 잔여 마커 안전 검증
DO $$
DECLARE
  old_row_count int;
  has_legacy_user_id boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname='public' AND tablename='test_user_markers'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM public.test_user_markers' INTO old_row_count;
    IF old_row_count > 0 THEN
      RAISE EXCEPTION 'test_user_markers row=% 존재. 수동 검토 필요 (Phase 1 abort).', old_row_count;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='test_user_markers'
        AND column_name='legacy_user_id'
    ) INTO has_legacy_user_id;

    IF NOT has_legacy_user_id THEN
      RAISE NOTICE '구버전 test_user_markers (legacy_user_id 컬럼 없음) — DROP 진행';
      DROP TABLE public.test_user_markers CASCADE;
    ELSE
      RAISE NOTICE 'test_user_markers v3 구조 (row=0) 그대로 활용';
    END IF;
  END IF;
END $$;

-- 마커 테이블 생성 (idempotent)
CREATE TABLE IF NOT EXISTS public.test_user_markers (
  user_id        uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  seed_batch_id  text NOT NULL,
  legacy_user_id bigint NOT NULL,
  user_type      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  note           text
);

CREATE UNIQUE INDEX IF NOT EXISTS test_user_markers_legacy_user_id_idx
  ON public.test_user_markers(legacy_user_id);

CREATE INDEX IF NOT EXISTS test_user_markers_batch_idx
  ON public.test_user_markers(seed_batch_id);

COMMENT ON COLUMN public.test_user_markers.user_type IS
  'newbie | normal | high_activity | admin | status_issue';

COMMIT;


-- ============================================================
-- ★ Phase 2-9: 단일 트랜잭션 — 모든 row INSERT + 검증
-- ============================================================
-- 하나라도 실패하면 전체 rollback. Phase 1 의 CREATE TABLE 은 보존.
BEGIN;

-- 2: Seed 데이터 임시 테이블
CREATE TEMP TABLE seed_users ON COMMIT DROP AS
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
  --   oranke idx: 1-4 / 7-14 / 19-24 / 27 / 29 = 20
  --   encre  idx: 5-6 / 15-18 / 25-26 / 28 / 30 = 10
  CASE
    WHEN gen.idx IN (1,2,3,4, 7,8,9,10,11,12,13,14, 19,20,21,22,23,24, 27, 29) THEN 'oranke'
    ELSE 'encre'
  END AS org_slug,
  CASE WHEN gen.idx % 2 = 1 THEN '남' ELSE '여' END AS gender,
  make_date(2001, ((gen.idx % 12) + 1), ((gen.idx % 28) + 1)) AS birth_date,
  (ARRAY['서울대','연세대','고려대','카이스트','포스텍','한양대','서강대','성균관대'])[((gen.idx - 1) % 8) + 1] AS school,
  (ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어학과','전자공학과','심리학과'])[((gen.idx - 1) % 6) + 1] AS department,
  CASE
    WHEN gen.idx = 29 THEN 'weekly_rest'
    WHEN gen.idx = 30 THEN 'graduated'
    ELSE 'active'
  END AS status_value
FROM gen;


-- 3: public.users (v4 신규 — FK 루트)
INSERT INTO public.users (
  id,
  legacy_user_id,
  created_at,
  updated_at
)
SELECT
  su.user_uuid,
  su.legacy_id,
  now() - INTERVAL '60 days',
  now()
FROM seed_users su;


-- 4: user_profiles (확정 17 컬럼)
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
  su.birth_date,                   -- date 타입
  su.gender,
  su.phone,
  su.email,
  su.status_value,
  NULL,                            -- growth_status (system-managed)
  su.org_slug,
  su.school,
  su.department,
  '서울시 성북구 (TEST)',
  su.email,                        -- auth_email
  NULL,                            -- contact_available
  NULL,                            -- role (운영진 구분은 admin_users 로)
  now() - INTERVAL '60 days',
  now()
FROM seed_users su;


-- 5: user_memberships
-- ⚠️ Q10 결과로 NOT NULL 컬럼 보강 필요할 수 있음
INSERT INTO public.user_memberships (
  user_id, team_name, part_name, membership_level, membership_state, is_current
)
SELECT
  su.user_uuid,
  (ARRAY['브랜딩','기획','미디어','신입'])[((su.idx - 1) % 4) + 1],
  CASE su.user_type
    WHEN 'newbie'        THEN '신입'
    WHEN 'admin'         THEN 'admin'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  CASE su.user_type
    WHEN 'admin'         THEN '운영진'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  su.status_value,
  true
FROM seed_users su;


-- 6: user_cumulative_points (Olympus Shield default = 5)
INSERT INTO public.user_cumulative_points (
  user_id, total_stars, total_shields, total_lightnings
)
SELECT
  su.user_uuid,
  CASE su.user_type
    WHEN 'newbie'        THEN floor(random() * 30)::int
    WHEN 'normal'        THEN 20 + floor(random() * 50)::int
    WHEN 'high_activity' THEN 60 + floor(random() * 60)::int
    WHEN 'admin'         THEN 80 + floor(random() * 70)::int
    ELSE                      30 + floor(random() * 50)::int
  END,
  CASE su.user_type
    WHEN 'newbie' THEN 5
    WHEN 'admin'  THEN 5
    ELSE 3 + floor(random() * 3)::int
  END,
  floor(random() * 10)::int
FROM seed_users su;


-- 7: user_growth_stats
INSERT INTO public.user_growth_stats (
  user_id, cumulative_weeks, approved_weeks
)
SELECT
  growth.user_uuid,
  growth.cumulative_weeks,
  LEAST(growth.cumulative_weeks, growth.approved_weeks_raw)
FROM (
  SELECT
    su.user_uuid,
    CASE su.user_type
      WHEN 'newbie'        THEN floor(random() * 4)::int
      WHEN 'normal'        THEN 4 + floor(random() * 5)::int
      WHEN 'high_activity' THEN 9 + floor(random() * 6)::int
      WHEN 'admin'         THEN 12 + floor(random() * 5)::int
      ELSE                      5 + floor(random() * 6)::int
    END AS cumulative_weeks,
    GREATEST(0,
      CASE su.user_type
        WHEN 'newbie'        THEN floor(random() * 3)::int
        WHEN 'normal'        THEN 3 + floor(random() * 5)::int
        WHEN 'high_activity' THEN 8 + floor(random() * 6)::int
        WHEN 'admin'         THEN 10 + floor(random() * 5)::int
        ELSE                      4 + floor(random() * 5)::int
      END
    ) AS approved_weeks_raw
  FROM seed_users su
) growth;


-- 8: applicants (kakao 가입 승인 완료 가정)
INSERT INTO public.applicants (
  email, name, provider, status, linked_user_id, reviewed_at, created_at, updated_at
)
SELECT
  su.email,
  su.display_name,
  'kakao',
  'approved',
  su.user_uuid,
  now() - INTERVAL '30 days',
  now() - INTERVAL '60 days',
  now()
FROM seed_users su;


-- 9: admin_users (운영진 2명 — idx 27, 28)
-- ⚠️ admin_users.id FK 가 auth.users 라면 본 INSERT 가 실패할 수 있음
--    실패 시 → admin_users 도 v5 (auth.users 와 함께) 로 분리
INSERT INTO public.admin_users (
  id, email, role, is_active, updated_at
)
SELECT
  su.user_uuid,
  su.email,
  CASE WHEN su.idx = 27 THEN 'owner' ELSE 'admin' END,
  true,
  now()
FROM seed_users su
WHERE su.user_type = 'admin';


-- 10: test_user_markers (마커 row 기록)
INSERT INTO public.test_user_markers (
  user_id, seed_batch_id, legacy_user_id, user_type, note
)
SELECT
  su.user_uuid,
  '2026-05-22_seed_30users_v1',
  su.legacy_id,
  su.user_type,
  'organization=' || su.org_slug
    || ', status=' || su.status_value
    || ', email=' || su.email
FROM seed_users su;


-- 11: 10중 검증 게이트
DO $$
DECLARE
  users_count int;
  profile_count int;
  marker_count int;
  oranke_count int;
  encre_count int;
  phalanx_dummy_count int;
  membership_count int;
  points_count int;
  growth_count int;
  applicant_count int;
  admin_count int;
BEGIN
  SELECT COUNT(*) INTO users_count
  FROM public.users
  WHERE legacy_user_id BETWEEN 900001 AND 900030;

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

  SELECT COUNT(*) INTO membership_count
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO points_count
  FROM public.user_cumulative_points ucp
  JOIN public.test_user_markers tm ON tm.user_id = ucp.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO growth_count
  FROM public.user_growth_stats ugs
  JOIN public.test_user_markers tm ON tm.user_id = ugs.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO applicant_count
  FROM public.applicants a
  JOIN public.test_user_markers tm ON tm.user_id = a.linked_user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO admin_count
  FROM public.admin_users au
  JOIN public.test_user_markers tm ON tm.user_id = au.id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  IF users_count        <> 30 THEN RAISE EXCEPTION 'users_count=% (30)', users_count; END IF;
  IF profile_count      <> 30 THEN RAISE EXCEPTION 'profile_count=% (30)', profile_count; END IF;
  IF marker_count       <> 30 THEN RAISE EXCEPTION 'marker_count=% (30)', marker_count; END IF;
  IF oranke_count       <> 20 THEN RAISE EXCEPTION 'oranke_count=% (20)', oranke_count; END IF;
  IF encre_count        <> 10 THEN RAISE EXCEPTION 'encre_count=% (10)', encre_count; END IF;
  IF phalanx_dummy_count <> 0 THEN
    RAISE EXCEPTION 'phalanx_dummy_count=% (0 — 실사용자 격리 위배)', phalanx_dummy_count;
  END IF;
  IF membership_count   <> 30 THEN RAISE EXCEPTION 'membership_count=% (30)', membership_count; END IF;
  IF points_count       <> 30 THEN RAISE EXCEPTION 'points_count=% (30)', points_count; END IF;
  IF growth_count       <> 30 THEN RAISE EXCEPTION 'growth_count=% (30)', growth_count; END IF;
  IF applicant_count    <> 30 THEN RAISE EXCEPTION 'applicant_count=% (30)', applicant_count; END IF;
  IF admin_count        <> 2  THEN RAISE EXCEPTION 'admin_count=% (2)', admin_count; END IF;

  RAISE NOTICE 'Phase 검증 통과 (11/11): users=%, profiles=%, markers=%, oranke=%, encre=%, phalanx_dummy=%, memberships=%, points=%, growth=%, applicants=%, admins=%',
    users_count, profile_count, marker_count, oranke_count, encre_count, phalanx_dummy_count,
    membership_count, points_count, growth_count, applicant_count, admin_count;
END $$;

COMMIT;


-- ============================================================
-- Rollback SQL v4 (별도 실행 — 4중 AND 마커 검증)
-- ============================================================
/*
BEGIN;

-- 1. 삭제 대상 추출 (4중 AND 마커 검증)
CREATE TEMP TABLE rollback_targets ON COMMIT DROP AS
SELECT
  tm.user_id,
  tm.legacy_user_id,
  up.auth_email,
  up.display_name,
  up.organization_slug
FROM public.user_profiles up
JOIN public.test_user_markers tm ON tm.user_id = up.user_id
WHERE
  tm.seed_batch_id = '2026-05-22_seed_30users_v1'
  AND tm.legacy_user_id BETWEEN 900001 AND 900030
  AND lower(up.auth_email) LIKE '%@vraxium.test'
  AND up.display_name LIKE '[TEST] %';

-- 2. 검증 (30 + phalanx=0)
DO $$
DECLARE
  target_count int;
  phalanx_in_targets int;
BEGIN
  SELECT COUNT(*) INTO target_count FROM rollback_targets;
  SELECT COUNT(*) INTO phalanx_in_targets
  FROM rollback_targets WHERE organization_slug = 'phalanx';

  IF target_count <> 30 THEN
    RAISE EXCEPTION 'Rollback 중단: 삭제 대상 % (30 이어야 함)', target_count;
  END IF;
  IF phalanx_in_targets > 0 THEN
    RAISE EXCEPTION 'Rollback 중단: phalanx 대상 % (0 이어야 함)', phalanx_in_targets;
  END IF;
END $$;

-- 3. 자식 row 삭제 (역순)
DELETE FROM public.test_user_markers WHERE user_id IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.admin_users        WHERE id      IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.applicants         WHERE linked_user_id IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.user_growth_stats  WHERE user_id IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.user_cumulative_points WHERE user_id IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.user_memberships   WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- 4. user_profiles → public.users 삭제
DELETE FROM public.user_profiles WHERE user_id IN (SELECT user_id FROM rollback_targets);
DELETE FROM public.users         WHERE id      IN (SELECT user_id FROM rollback_targets);

-- 5. 사후 검증
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-22_seed_30users_v1';
  IF remaining > 0 THEN RAISE EXCEPTION 'markers 잔존 % 건', remaining; END IF;

  SELECT COUNT(*) INTO remaining
  FROM public.users
  WHERE legacy_user_id BETWEEN 900001 AND 900030;
  IF remaining > 0 THEN RAISE EXCEPTION 'public.users 잔존 % 건', remaining; END IF;

  SELECT COUNT(*) INTO remaining
  FROM public.user_profiles
  WHERE display_name LIKE '[TEST] %';
  IF remaining > 0 THEN RAISE EXCEPTION '[TEST] prefix 잔존 % 건', remaining; END IF;

  RAISE NOTICE 'Rollback v4 완료';
END $$;

COMMIT;
*/


-- ============================================================
-- 적용 후 권장 검증 SQL (phalanx 영향 zero 확인)
-- ============================================================
-- (1) batch 30명 확인:
--     SELECT seed_batch_id, COUNT(*) FROM public.test_user_markers GROUP BY 1;
--
-- (2) phalanx 실사용자 row 변화량 (Seed 전/후 동일해야):
--     SELECT COUNT(*) FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     WHERE up.organization_slug = 'phalanx' AND tm.user_id IS NULL;
--     Expected: 34
--
-- (3) phalanx updated_at 변화 (영향 zero 검증):
--     SELECT COUNT(*) FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     WHERE up.organization_slug = 'phalanx'
--       AND up.updated_at >= now() - INTERVAL '10 minutes'
--       AND tm.user_id IS NULL;
--     Expected: 0
--
-- (4) 조직별 dummy/real 분포:
--     SELECT up.organization_slug,
--            COUNT(*) FILTER (WHERE tm.user_id IS NOT NULL) AS dummy_count,
--            COUNT(*) FILTER (WHERE tm.user_id IS NULL) AS real_count
--     FROM public.user_profiles up
--     LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id
--     GROUP BY up.organization_slug ORDER BY up.organization_slug;
--     Expected:
--       encre   | 10 | 0
--       oranke  | 20 | 0
--       phalanx |  0 | 34


-- ============================================================
-- 다음 단계 (v5+)
-- ============================================================
-- v5: auth.users + login flow (직접 SQL INSERT vs Supabase Auth admin API)
-- v6: Cluster2 콘텐츠 (user_cluster2, user_introductions, user_educations,
--     user_resume_card_settings, user_review_links)
-- v7: Cluster3 (portfolio_top_cards, portfolio_channel_cards)
-- v8: Cluster4 (user_activity_details, weekly_*, career_*) — target_season CTE
