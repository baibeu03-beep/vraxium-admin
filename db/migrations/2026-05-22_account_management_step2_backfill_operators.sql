-- 2026-05-22_account_management_step2_backfill_operators.sql
-- 계정 관리 — Step 2: 기존 운영자 2명 백필 (probe 2026-05-22 결과 기준).
--
-- probe 결과:
--   - admin_users 2 rows (둘 다 role='admin', is_active=true)
--     · aac4639b-7c22-4a53-9f2e-08076d5aa620  vanuatu.golden@gmail.com
--     · c28b2409-4118-49fc-a42e-68e18dbd194c  ynalee1130@gmail.com
--   - 두 운영자에 대한 users / user_profiles row 모두 0건
--   - user_profiles 의 위 두 이메일 충돌 0건
--
-- 본 마이그레이션은:
--   1) public.users      에 두 운영자 row 백필 (legacy_user_id sequence default 사용)
--   2) public.user_profiles 에 두 운영자 row 백필 (role='super_admin', status='active')
--
-- 의존성: step1_schema (user_profiles.role 컬럼 존재).
-- 멱등성: 두 INSERT 모두 ON CONFLICT 처리 + 이중 가드 (id + lower(email) + is_active).
-- 안전성: WHERE 조건이 어긋난 row 는 자연스럽게 0건 처리 (no-op).
--
-- 주의: 본 마이그레이션 실행 직전, 아래 쿼리 결과가 0건임을 한 번 더 확인하세요.
--   SELECT user_id, auth_email FROM public.user_profiles
--    WHERE lower(auth_email) IN ('vanuatu.golden@gmail.com','ynalee1130@gmail.com');

-- ─────────────────────────────────────────────────────────────────────
-- 1. public.users 백필
-- ─────────────────────────────────────────────────────────────────────
-- legacy_user_id 는 2026-05-11_users_legacy_user_id_default.sql 의 sequence default
-- (100000000+) 가 자동 부여한다. 명시 컬럼은 id 만.
INSERT INTO public.users (id)
SELECT au.id
  FROM public.admin_users au
 WHERE au.id IN (
         'aac4639b-7c22-4a53-9f2e-08076d5aa620'::uuid,
         'c28b2409-4118-49fc-a42e-68e18dbd194c'::uuid
       )
   AND lower(au.email) IN ('vanuatu.golden@gmail.com', 'ynalee1130@gmail.com')
   AND au.is_active = true
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. public.user_profiles 백필
-- ─────────────────────────────────────────────────────────────────────
-- user_profiles_auth_email_unique_idx (2026-05-08_admin_applicants.sql 가 정의) 가
-- lower(auth_email) UNIQUE 를 보장하므로, 동일 이메일이 다른 user_id 로 이미 있다면
-- 본 INSERT 가 23505 로 실패한다 — 의도된 보호 (위 사전 SELECT 0건이 전제).
--
-- ON CONFLICT (user_id) DO UPDATE: 이미 user_profiles row 가 있으면서 role 이 NULL
-- 또는 일반 role 인 경우만 super_admin 으로 승격. 이미 admin/super_admin 이면 보존.
INSERT INTO public.user_profiles (
  user_id,
  auth_email,
  contact_email,
  display_name,
  role,
  status,
  growth_status
)
SELECT
  au.id,
  lower(au.email),
  lower(au.email),
  split_part(au.email, '@', 1),
  'super_admin',
  'active',
  'active'
  FROM public.admin_users au
 WHERE au.id IN (
         'aac4639b-7c22-4a53-9f2e-08076d5aa620'::uuid,
         'c28b2409-4118-49fc-a42e-68e18dbd194c'::uuid
       )
   AND lower(au.email) IN ('vanuatu.golden@gmail.com', 'ynalee1130@gmail.com')
   AND au.is_active = true
ON CONFLICT (user_id) DO UPDATE
  SET role = CASE
               WHEN public.user_profiles.role IS NULL
                 OR public.user_profiles.role NOT IN ('admin','super_admin')
               THEN 'super_admin'
               ELSE public.user_profiles.role
             END;

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (마이그레이션 직후 SQL Editor 에서 한 번 실행해 확인)
-- ─────────────────────────────────────────────────────────────────────
-- SELECT u.id, u.legacy_user_id, up.role, up.auth_email
--   FROM public.users u
--   JOIN public.user_profiles up ON up.user_id = u.id
--  WHERE u.id IN (
--    'aac4639b-7c22-4a53-9f2e-08076d5aa620'::uuid,
--    'c28b2409-4118-49fc-a42e-68e18dbd194c'::uuid
--  );
-- 기대: 2행. legacy_user_id 는 100000000 이상의 정수.
--       role='super_admin', auth_email 은 소문자 이메일.
