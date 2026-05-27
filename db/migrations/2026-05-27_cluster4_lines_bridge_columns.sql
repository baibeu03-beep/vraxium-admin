-- 2026-05-27_cluster4_lines_bridge_columns.sql
-- cluster4_lines 테이블에 레거시 호환 + 확장 컬럼 4개 추가.
--
-- 배경:
--   weekly_activities / activity_records 가 운영 DB 에 존재하지 않으므로,
--   cluster4_lines 가 유일한 라인 개설 시스템이다.
--   프론트가 기대하는 activity_type_id 기반 매핑을 위해 브릿지 컬럼을 추가한다.
--
-- 추가 컬럼:
--   1) activity_type_id — activity_types.id 와 동일 text 값. 프론트 연결 키.
--   2) output_images    — 운영자 이미지 복수 (jsonb array).
--   3) team_id          — 실무 경험 팀 지정.
--   4) career_project_id — 경력 프로젝트 연결.
--
-- 부분 UNIQUE:
--   활성(is_active=true) 라인 간 동일 activity_type_id 금지.
--   비활성 라인은 중복 허용 (히스토리 보존).
--
-- 재실행 안전:
--   ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS activity_type_id    text         NULL,
  ADD COLUMN IF NOT EXISTS output_images       jsonb        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS team_id             uuid         NULL,
  ADD COLUMN IF NOT EXISTS career_project_id   uuid         NULL;

-- career_project_id FK (safe — ignore if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_lines_career_project_id_fkey'
      AND conrelid = 'public.cluster4_lines'::regclass
  ) THEN
    ALTER TABLE public.cluster4_lines
      ADD CONSTRAINT cluster4_lines_career_project_id_fkey
      FOREIGN KEY (career_project_id) REFERENCES public.career_projects(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- 활성 라인 간 동일 activity_type_id 금지
CREATE UNIQUE INDEX IF NOT EXISTS cluster4_lines_activity_type_id_active_unique
  ON public.cluster4_lines (activity_type_id)
  WHERE activity_type_id IS NOT NULL AND is_active = true;

-- activity_type_id 조회용 인덱스
CREATE INDEX IF NOT EXISTS cluster4_lines_activity_type_id_idx
  ON public.cluster4_lines (activity_type_id)
  WHERE activity_type_id IS NOT NULL;

-- career_project_id 조회용 인덱스
CREATE INDEX IF NOT EXISTS cluster4_lines_career_project_id_idx
  ON public.cluster4_lines (career_project_id)
  WHERE career_project_id IS NOT NULL;

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP INDEX IF EXISTS public.cluster4_lines_career_project_id_idx;
DROP INDEX IF EXISTS public.cluster4_lines_activity_type_id_idx;
DROP INDEX IF EXISTS public.cluster4_lines_activity_type_id_active_unique;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_career_project_id_fkey;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS career_project_id,
  DROP COLUMN IF EXISTS team_id,
  DROP COLUMN IF EXISTS output_images,
  DROP COLUMN IF EXISTS activity_type_id;
COMMIT;
*/
