-- 2026-05-22_career_projects_admin_meta.sql
-- career_projects 어드민 운영(CRUD)용 메타 컬럼·인덱스·트리거 도입.
--
-- 배경:
--   #12 (step2_career_projects) 가 마스터 테이블의 canonical 컬럼만 정의했다.
--   본 마이그레이션은 admin 콘솔의 CRUD 운영(목록 정렬·수정 시각 추적)을 위해
--   updated_at 컬럼·정렬 인덱스·BEFORE UPDATE 트리거를 추가한다.
--
-- 정합성:
--   - 기존 컬럼은 손대지 않는다 (사용자 화면 호환성 유지).
--   - updated_at 은 application 코드 없이 트리거로만 갱신되어
--     adminCareerProjectsData.ts 의 update payload 에서 직접 세팅하지 않아도 된다.
--
-- 비범위:
--   - seed 데이터 — admin UI 로 생성
--   - RLS — 마이그레이션 컨벤션상 service_role 전용 write 유지
--
-- 재실행 안전:
--   - ALTER TABLE … ADD COLUMN IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS

BEGIN;

ALTER TABLE public.career_projects
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS career_projects_created_at_desc_idx
  ON public.career_projects (created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_career_projects_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS career_projects_set_updated_at ON public.career_projects;

CREATE TRIGGER career_projects_set_updated_at
BEFORE UPDATE ON public.career_projects
FOR EACH ROW
EXECUTE FUNCTION public.touch_career_projects_updated_at();

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TRIGGER IF EXISTS career_projects_set_updated_at ON public.career_projects;
DROP FUNCTION IF EXISTS public.touch_career_projects_updated_at();
DROP INDEX IF EXISTS public.career_projects_created_at_desc_idx;
ALTER TABLE public.career_projects DROP COLUMN IF EXISTS updated_at;
COMMIT;
*/
