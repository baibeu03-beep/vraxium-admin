-- 2026-05-08_admin_users_hardening.sql
-- admin_users 권한/활성 상태 보강 + role 정규화

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.admin_users
SET role = 'admin'
WHERE role IS NULL
   OR role NOT IN ('owner', 'admin', 'viewer');

ALTER TABLE public.admin_users
  ALTER COLUMN role SET DEFAULT 'admin';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'admin_users_role_check'
  ) THEN
    ALTER TABLE public.admin_users
      ADD CONSTRAINT admin_users_role_check
      CHECK (role IN ('owner', 'admin', 'viewer'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_unique_idx
  ON public.admin_users (lower(email));

CREATE OR REPLACE FUNCTION public.touch_admin_users_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_users_set_updated_at ON public.admin_users;

CREATE TRIGGER admin_users_set_updated_at
BEFORE UPDATE ON public.admin_users
FOR EACH ROW
EXECUTE FUNCTION public.touch_admin_users_updated_at();
