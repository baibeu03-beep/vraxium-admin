-- 2026-05-22_permissions_matrix_step1_tables.sql
-- 권한 매트릭스 관리 페이지용 canonical 테이블 3종 생성.
--   1) permissions               : 권한 키 카탈로그 (cluster.resource.action)
--   2) role_permissions          : role × permission 매트릭스 (행 없음 = OFF)
--   3) role_permissions_audit    : super_admin 의 변경 이력 추적
-- 본 마이그레이션은 schema 만 만들며, seed 는 step2 에서 별도 적용한다.
-- 실제 권한 gate (API/Front) 연결은 별도 단계에서 진행한다.
--
-- 의존성: 없음. (gen_random_uuid() 는 pgcrypto, Supabase 환경에서는 기본 활성.)
-- 멱등성: 모든 DDL 이 IF NOT EXISTS / DO $$ pg_constraint 가드 / CREATE OR REPLACE 사용.

-- ─────────────────────────────────────────────────────────────────────
-- 1. permissions ─ 권한 키 카탈로그
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permissions (
  key                   text PRIMARY KEY,
  cluster               text NOT NULL,
  resource              text NOT NULL,
  action                text NOT NULL,
  label                 text NOT NULL,
  description           text NULL,
  requires_edit_window  boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 100,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'permissions_action_check'
  ) THEN
    ALTER TABLE public.permissions
      ADD CONSTRAINT permissions_action_check
      CHECK (action IN ('view','edit'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS permissions_cluster_idx
  ON public.permissions (cluster, sort_order);

CREATE INDEX IF NOT EXISTS permissions_sort_order_idx
  ON public.permissions (sort_order);

CREATE OR REPLACE FUNCTION public.touch_permissions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS permissions_set_updated_at ON public.permissions;

CREATE TRIGGER permissions_set_updated_at
BEFORE UPDATE ON public.permissions
FOR EACH ROW
EXECUTE FUNCTION public.touch_permissions_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 2. role_permissions ─ role × permission 매트릭스
-- ─────────────────────────────────────────────────────────────────────
-- role 컬럼은 application 의 user-facing role 7 종을 문자열로 직접 저장한다.
-- 'super_admin' 은 admin_users.role='owner' 와 logical 로 매핑되며 (API gate 단에서 변환),
-- 본 테이블에는 'super_admin' 문자열을 그대로 보관한다.
-- 행이 없는 (role, permission) 조합은 application 단에서 OFF 로 해석한다.
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role            text NOT NULL,
  permission_key  text NOT NULL
    REFERENCES public.permissions(key) ON DELETE CASCADE,
  is_allowed      boolean NOT NULL DEFAULT false,
  updated_by      uuid NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission_key)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_role_check'
  ) THEN
    ALTER TABLE public.role_permissions
      ADD CONSTRAINT role_permissions_role_check
      CHECK (role IN (
        'crew','ambassador','agent','part_leader','team_leader','admin','super_admin'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS role_permissions_permission_idx
  ON public.role_permissions (permission_key);

CREATE INDEX IF NOT EXISTS role_permissions_role_idx
  ON public.role_permissions (role);

CREATE OR REPLACE FUNCTION public.touch_role_permissions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS role_permissions_set_updated_at ON public.role_permissions;

CREATE TRIGGER role_permissions_set_updated_at
BEFORE UPDATE ON public.role_permissions
FOR EACH ROW
EXECUTE FUNCTION public.touch_role_permissions_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 3. role_permissions_audit ─ 변경 이력 (append-only)
-- ─────────────────────────────────────────────────────────────────────
-- super_admin 단독 변경 정책상 추적 가치가 크므로 v1 부터 포함한다.
-- changed_by 는 admin_users.id (= auth.users.id) 를 기록한다.
CREATE TABLE IF NOT EXISTS public.role_permissions_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role            text NOT NULL,
  permission_key  text NOT NULL,
  old_is_allowed  boolean NULL,
  new_is_allowed  boolean NOT NULL,
  changed_by      uuid NOT NULL,
  reason          text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_permissions_audit_role_idx
  ON public.role_permissions_audit (role);

CREATE INDEX IF NOT EXISTS role_permissions_audit_permission_idx
  ON public.role_permissions_audit (permission_key);

CREATE INDEX IF NOT EXISTS role_permissions_audit_changed_by_idx
  ON public.role_permissions_audit (changed_by);

CREATE INDEX IF NOT EXISTS role_permissions_audit_created_at_idx
  ON public.role_permissions_audit (created_at DESC);
