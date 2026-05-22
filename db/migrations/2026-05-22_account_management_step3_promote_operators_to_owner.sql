-- 2026-05-22_account_management_step3_promote_operators_to_owner.sql
-- 계정 관리 — Step 3: 기존 운영자 2명 admin_users.role 'admin' → 'owner' 승격.
--
-- 배경:
--   admin_users.role 의 owner 는 application 단에서 super_admin 으로 logical 매핑된다.
--   (예: requireAdmin(['owner']) 가 권한 매트릭스 PATCH gate.)
--   probe 시점에 두 운영자는 모두 role='admin' 이라 super_admin gate 를 통과하지 못한다.
--   본 step 은 그 두 계정을 owner 로 승격해 super_admin 권한을 확보한다.
--
-- 의존성: step2_backfill (운영자 user_profiles row 가 'super_admin' 으로 존재).
-- 멱등성: WHERE role='admin' 추가 → 이미 owner 면 0건 처리, 재실행 안전.
-- 안전성: id + lower(email) + is_active 삼중 가드. 운영자가 admin_users.email 을 손으로
--          바꾼 상태에선 0건 처리.

-- 실제 owner 승격
UPDATE public.admin_users
   SET role = 'owner'
 WHERE id IN (
         'aac4639b-7c22-4a53-9f2e-08076d5aa620'::uuid,
         'c28b2409-4118-49fc-a42e-68e18dbd194c'::uuid
       )
   AND lower(email) IN ('vanuatu.golden@gmail.com', 'ynalee1130@gmail.com')
   AND role = 'admin'
   AND is_active = true;

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (마이그레이션 직후 SQL Editor 에서 한 번 실행해 확인)
-- ─────────────────────────────────────────────────────────────────────
-- SELECT id, email, role, is_active
--   FROM public.admin_users
--  WHERE id IN (
--    'aac4639b-7c22-4a53-9f2e-08076d5aa620'::uuid,
--    'c28b2409-4118-49fc-a42e-68e18dbd194c'::uuid
--  );
-- 기대: 2행. 둘 다 role='owner', is_active=true.
--
-- SELECT role, count(*) FROM public.admin_users GROUP BY role ORDER BY role;
-- 기대: owner=2 (probe 0-c 에서 admin=2 였으므로). 다른 admin/viewer 가 추가됐다면 반영.
--
-- ─────────────────────────────────────────────────────────────────────
-- Step 3 직후 수동 스모크 (운영자 본인이 브라우저에서)
-- ─────────────────────────────────────────────────────────────────────
-- 1. /login 에서 비밀번호 로그인 → /admin 으로 정상 진입.
-- 2. 사이드바 → 시스템 → 운영 관리 → 권한 설정 으로 이동.
-- 3. 응답의 isSuperAdmin === true 여야 토글이 활성화된다.
--    (이전엔 admin 이라 disabled 였음 — 본 step 의 의도된 효과.)
-- 4. 임의 셀 한 번 토글 → role_permissions / role_permissions_audit 에 row 생성 확인.
-- 5. 운영자 2명 모두 동일하게 확인.
