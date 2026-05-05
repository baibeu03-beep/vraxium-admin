-- 2026-05-05_admin_crew_management.sql
-- Admin app에서 legacy_crew_import를 관리하기 위한 컬럼 추가 + crew_list_view 재정의.
-- Supabase SQL Editor에서 그대로 실행할 수 있다.
-- 주의: crew_list_view는 User App /crews가 읽는 뷰이므로
--       기존 컬럼 셋(legacy_user_id, display_name, team_name, part_name, cumulative_weeks)을
--       동일하게 유지해야 한다. 운영 환경에 다른 컬럼이 추가되어 있다면
--       아래 SELECT 절에 같이 넣어 줘야 한다.

-- 1. 관리용 컬럼 추가 -----------------------------------------------------
ALTER TABLE public.legacy_crew_import
  ADD COLUMN IF NOT EXISTS is_visible  boolean      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS admin_note  text,
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz  NOT NULL DEFAULT now();

-- 2. updated_at 자동 갱신 트리거 -----------------------------------------
CREATE OR REPLACE FUNCTION public.tg_legacy_crew_import_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS legacy_crew_import_set_updated_at ON public.legacy_crew_import;

CREATE TRIGGER legacy_crew_import_set_updated_at
BEFORE UPDATE ON public.legacy_crew_import
FOR EACH ROW
EXECUTE FUNCTION public.tg_legacy_crew_import_set_updated_at();

-- 3. crew_list_view 재정의 (is_visible = true만 노출) --------------------
DROP VIEW IF EXISTS public.crew_list_view;

CREATE VIEW public.crew_list_view AS
SELECT
  legacy_user_id,
  display_name,
  team_name,
  part_name,
  cumulative_weeks
FROM public.legacy_crew_import
WHERE is_visible = true;

-- User App(anon)이 읽을 수 있도록 권한 부여(이미 있다면 무시됨)
GRANT SELECT ON public.crew_list_view TO anon, authenticated;
