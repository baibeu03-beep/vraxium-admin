-- 2026-05-22_account_management_step1_schema.sql
-- 계정 관리(Account Management) — Step 1: schema only.
--   1) public.user_profiles 에 role 컬럼 추가 (NULL 허용, 7개 user-facing role CHECK)
--   2) public.user_role_audit 테이블 생성 (role 변경 이력 추적)
-- 본 마이그레이션은 컬럼/테이블 정의만 추가하며, 데이터 변경은 step2/step3 에서 수행.
-- NOT NULL 강제는 백필 완료 + 운영 안정화 이후 별도 후속 마이그레이션에서 진행.
--
-- 의존성: 없음 (gen_random_uuid 는 Supabase 환경 기본 활성).
-- 멱등성: IF NOT EXISTS / DO $$ pg_constraint 가드 / CREATE OR REPLACE 패턴 사용.

-- ─────────────────────────────────────────────────────────────────────
-- 1. user_profiles.role 컬럼
-- ─────────────────────────────────────────────────────────────────────
-- user_profiles.role 은 application 의 7개 user-facing role 의 1차 저장 위치.
-- 'admin' / 'super_admin' 값은 admin_users 와의 dual-write 로 동기화된다 (gate 단 logical 매핑 별도):
--   user_profiles.role='admin'       ⇔ admin_users(id=user_id).role='admin'
--   user_profiles.role='super_admin' ⇔ admin_users(id=user_id).role='owner'   (logical 매핑)
-- 권한 매트릭스(role_permissions) 의 row 매칭 키는 user_profiles.role 의 7개 값을 사용한다.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS role text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_role_check'
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_role_check
      CHECK (role IS NULL OR role IN (
        'crew','ambassador','agent','part_leader','team_leader','admin','super_admin'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_profiles_role_idx
  ON public.user_profiles (role);

-- ─────────────────────────────────────────────────────────────────────
-- 2. user_role_audit ─ role 변경 이력 (append-only)
-- ─────────────────────────────────────────────────────────────────────
-- super_admin 단독 변경 정책상 추적 가치가 크므로 v1 부터 포함한다.
-- changed_by 는 admin_users.id (= auth.users.id) 를 기록한다.
-- old_role/new_role 둘 다 nullable: 최초 role 부여 (NULL → 'crew') 및
-- 행 자체가 삭제되기 전 마지막 강등 ('super_admin' → NULL) 도 기록 가능.
CREATE TABLE IF NOT EXISTS public.user_role_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL
    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  old_role    text NULL,
  new_role    text NULL,
  changed_by  uuid NOT NULL,
  reason      text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_role_audit_user_id_idx
  ON public.user_role_audit (user_id);

CREATE INDEX IF NOT EXISTS user_role_audit_changed_by_idx
  ON public.user_role_audit (changed_by);

CREATE INDEX IF NOT EXISTS user_role_audit_created_at_idx
  ON public.user_role_audit (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (마이그레이션 직후 SQL Editor 에서 한 번 실행해 확인)
-- ─────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='user_profiles' AND column_name='role';
-- 기대: role / text / YES
--
-- SELECT conname FROM pg_constraint WHERE conname='user_profiles_role_check';
-- 기대: 1행
--
-- SELECT count(*) FROM public.user_role_audit;
-- 기대: 0
