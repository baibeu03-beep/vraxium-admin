-- 2026-05-08_admin_applicants.sql
-- Pending applicant를 기존 user_profiles와 수동 연결하기 위한 admin 도메인.

CREATE TABLE IF NOT EXISTS public.applicants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  linked_user_id uuid NULL REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,
  reviewed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS applicants_status_created_at_idx
  ON public.applicants (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_auth_email_unique_idx
  ON public.user_profiles (lower(auth_email))
  WHERE auth_email IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_applicants_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS applicants_set_updated_at ON public.applicants;

CREATE TRIGGER applicants_set_updated_at
BEFORE UPDATE ON public.applicants
FOR EACH ROW
EXECUTE FUNCTION public.touch_applicants_updated_at();
