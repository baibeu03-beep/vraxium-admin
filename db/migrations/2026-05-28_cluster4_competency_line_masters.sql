-- 2026-05-28_cluster4_competency_line_masters.sql
-- Cluster4 역량(competency) 라인 마스터 테이블 생성 + cluster4_lines 확장.
--
-- 생성 테이블:
--   1) cluster4_competency_line_masters — 역량 라인 코드 마스터 (조직별 관리)
--
-- 확장:
--   2) cluster4_lines.competency_line_master_id — 역량 마스터 FK
--
-- 정책:
--   - team_id 컬럼 없음 (experience_line_masters 와 달리 팀 귀속 없음).
--   - organization_slug 으로 조직별 라인 코드 관리.
--   - seed 데이터는 별도 마이그레이션에서 투입.
--
-- 의존:
--   - public.cluster4_lines (2026-05-26_cluster4_line_opening_step1_tables.sql)
--   - public.touch_cluster4_updated_at() (same)
--
-- 재실행 안전: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--   guarded FK creation (DO $$ block).

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: cluster4_competency_line_masters
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cluster4_competency_line_masters (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_slug   text         NOT NULL DEFAULT 'oranke',
  line_code           text         NOT NULL,
  line_name           text         NOT NULL,
  main_title          text         NULL,
  source_file_name    text         NULL,
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_competency_line_masters_org_line_code_unique
    UNIQUE (organization_slug, line_code)
);

CREATE INDEX IF NOT EXISTS cluster4_competency_line_masters_org_slug_idx
  ON public.cluster4_competency_line_masters (organization_slug);

CREATE INDEX IF NOT EXISTS cluster4_competency_line_masters_is_active_idx
  ON public.cluster4_competency_line_masters (is_active);

-- updated_at trigger (재사용: touch_cluster4_updated_at 은 step1_tables 에서 생성됨)
DROP TRIGGER IF EXISTS cluster4_competency_line_masters_set_updated_at
  ON public.cluster4_competency_line_masters;

CREATE TRIGGER cluster4_competency_line_masters_set_updated_at
BEFORE UPDATE ON public.cluster4_competency_line_masters
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

GRANT SELECT ON public.cluster4_competency_line_masters TO anon, authenticated;

COMMENT ON TABLE public.cluster4_competency_line_masters
  IS '역량(competency) 라인 코드 마스터. 조직별 역량 평가 라인을 관리.';
COMMENT ON COLUMN public.cluster4_competency_line_masters.organization_slug
  IS '소속 조직 (encre / oranke / phalanx). 라인 코드는 조직 내에서만 unique.';
COMMENT ON COLUMN public.cluster4_competency_line_masters.line_code
  IS '라인 식별 코드. UNIQUE(organization_slug, line_code).';
COMMENT ON COLUMN public.cluster4_competency_line_masters.source_file_name
  IS '원본 엑셀 파일명 (import 이력 추적용).';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: cluster4_lines 확장 — competency_line_master_id
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS competency_line_master_id uuid NULL;

-- competency_line_master_id FK (guard: skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_lines_competency_line_master_id_fkey'
      AND conrelid = 'public.cluster4_lines'::regclass
  ) THEN
    ALTER TABLE public.cluster4_lines
      ADD CONSTRAINT cluster4_lines_competency_line_master_id_fkey
      FOREIGN KEY (competency_line_master_id)
      REFERENCES public.cluster4_competency_line_masters(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS cluster4_lines_competency_line_master_id_idx
  ON public.cluster4_lines (competency_line_master_id)
  WHERE competency_line_master_id IS NOT NULL;


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

-- cluster4_lines 확장 컬럼 제거
DROP INDEX IF EXISTS public.cluster4_lines_competency_line_master_id_idx;
ALTER TABLE public.cluster4_lines
  DROP CONSTRAINT IF EXISTS cluster4_lines_competency_line_master_id_fkey;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS competency_line_master_id;

-- competency line masters
DROP TRIGGER IF EXISTS cluster4_competency_line_masters_set_updated_at
  ON public.cluster4_competency_line_masters;
DROP TABLE IF EXISTS public.cluster4_competency_line_masters;

COMMIT;
*/
