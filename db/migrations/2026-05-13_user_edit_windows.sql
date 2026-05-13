-- 2026-05-13_user_edit_windows.sql
-- 범용 "사용자 X 리소스 별 편집 가능 기간" 관리 테이블.
-- 1차 적용 resource_key: 'cluster2.review_links'.
-- 향후 cluster3/cluster4 등 resource_key 만 추가하면 같은 구조로 확장된다.

CREATE TABLE IF NOT EXISTS public.user_edit_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id uuid NOT NULL
    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  resource_key text NOT NULL,

  opened_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,

  granted_by uuid NULL,
  note text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, resource_key)
);

CREATE INDEX IF NOT EXISTS user_edit_windows_user_id_idx
  ON public.user_edit_windows (user_id);

CREATE INDEX IF NOT EXISTS user_edit_windows_resource_key_idx
  ON public.user_edit_windows (resource_key);

CREATE INDEX IF NOT EXISTS user_edit_windows_active_idx
  ON public.user_edit_windows (user_id, resource_key, opened_at, expires_at);

CREATE OR REPLACE FUNCTION public.touch_user_edit_windows_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_edit_windows_set_updated_at
  ON public.user_edit_windows;

CREATE TRIGGER user_edit_windows_set_updated_at
BEFORE UPDATE ON public.user_edit_windows
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_edit_windows_updated_at();
