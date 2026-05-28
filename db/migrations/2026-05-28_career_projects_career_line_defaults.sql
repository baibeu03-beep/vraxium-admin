-- 2026-05-28_career_projects_career_line_defaults.sql
-- career_projects에 실무 경력 라인 등록/개설 MVP 필수 컬럼 추가.
--
-- 배경:
--   Cluster4 career 파트의 2단계(등록→개설) 흐름을 위해
--   career_projects가 경력 라인 마스터 역할을 하되,
--   기본 메인타이틀/Output/선발 크루 등 개설 시 기본값을 저장해야 한다.
--
-- 추가 컬럼:
--   - start_date / end_date: 프로젝트 실제 기간
--   - default_main_title: 개설 시 기본 메인 타이틀 (없으면 line_name 사용)
--   - default_output_link_1/2: 개설 시 기본 Output Link
--   - default_output_images: 개설 시 기본 Output Images (jsonb)
--   - default_target_user_ids: 선발 크루 UUID 배열 (jsonb)
--   - organization_slug: 조직 구분 (experience/competency 마스터와 일관성)
--
-- 인덱스:
--   - UNIQUE(organization_slug, line_code) WHERE line_code IS NOT NULL
--
-- 기존 데이터 영향: 전부 NULL 또는 DEFAULT → 기존 row 무영향.
-- 재실행 안전: ALTER TABLE ... ADD COLUMN IF NOT EXISTS

BEGIN;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS start_date date NULL;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS end_date date NULL;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS default_main_title text NULL;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS default_output_link_1 text NULL;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS default_output_link_2 text NULL;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS default_output_images jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS default_target_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS organization_slug text NOT NULL DEFAULT 'oranke';

ALTER TABLE public.career_projects
  ADD CONSTRAINT career_projects_date_range_chk
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);

CREATE UNIQUE INDEX IF NOT EXISTS career_projects_org_line_code_unique_idx
  ON public.career_projects (organization_slug, line_code)
  WHERE line_code IS NOT NULL;

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP INDEX IF EXISTS public.career_projects_org_line_code_unique_idx;
ALTER TABLE public.career_projects DROP CONSTRAINT IF EXISTS career_projects_date_range_chk;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS organization_slug;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS default_target_user_ids;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS default_output_images;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS default_output_link_2;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS default_output_link_1;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS default_main_title;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS end_date;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS start_date;
COMMIT;
*/
