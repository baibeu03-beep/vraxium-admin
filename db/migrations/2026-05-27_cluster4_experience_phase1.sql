-- 2026-05-27_cluster4_experience_phase1.sql
-- Cluster4 실무 경험 Phase 1 — DB 구조 구축.
--
-- 생성 테이블:
--   1) cluster4_teams           — 팀 마스터 (line_master / cluster4_lines 공용)
--   2) cluster4_experience_line_masters — 실무 경험 라인 코드 마스터
--   3) cluster4_experience_line_evaluations — 실무 경험 평가 (rating 0~10, points = rating)
--
-- 확장:
--   4) cluster4_lines.line_code                    — 라인 코드 (nullable, backfill 후 NOT NULL 검토)
--   5) cluster4_lines.experience_line_master_id    — 실무 경험 마스터 FK
--   6) 기존 cluster4_lines.team_id → cluster4_teams FK 추가
--
-- Backfill:
--   7) cluster4_lines.line_code ← activity_types.line_code (info/competency)
--   8) cluster4_lines.line_code ← career_projects.line_code (career)
--
-- 정책:
--   - points 컬럼 없음. points = rating (1:1 계산값).
--   - 포인트 표시명은 organization_resume_card_settings.point_label 에서 조회.
--   - user_weekly_points 와 별개 도메인.
--
-- 의존:
--   - public.cluster4_lines (2026-05-26_cluster4_line_opening_step1_tables.sql)
--   - public.cluster4_line_targets (same)
--   - public.user_profiles(user_id)
--   - public.admin_users(id)
--   - public.activity_types(id, line_code)
--   - public.career_projects(id, line_code)
--   - public.legacy_crew_import(team_name) — seed source
--
-- 재실행 안전: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--   ON CONFLICT DO NOTHING, DO $$ guard 패턴.

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: cluster4_teams
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cluster4_teams (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name   text         NOT NULL UNIQUE,
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cluster4_teams_is_active_idx
  ON public.cluster4_teams (is_active);

-- updated_at trigger (재사용: touch_cluster4_updated_at 은 step1_tables 에서 생성됨)
DROP TRIGGER IF EXISTS cluster4_teams_set_updated_at
  ON public.cluster4_teams;

CREATE TRIGGER cluster4_teams_set_updated_at
BEFORE UPDATE ON public.cluster4_teams
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

GRANT SELECT ON public.cluster4_teams TO anon, authenticated;

COMMENT ON TABLE public.cluster4_teams
  IS '실무 경험 팀 마스터. cluster4_experience_line_masters.team_id 및 cluster4_lines.team_id 에서 참조.';

-- Seed: legacy_crew_import 의 distinct team_name
INSERT INTO public.cluster4_teams (team_name)
SELECT DISTINCT btrim(team_name)
FROM public.legacy_crew_import
WHERE team_name IS NOT NULL
  AND btrim(team_name) <> ''
ORDER BY btrim(team_name)
ON CONFLICT (team_name) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: cluster4_experience_line_masters
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cluster4_experience_line_masters (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  line_code           text         NOT NULL UNIQUE,
  line_name           text         NOT NULL,
  default_main_title  text         NULL,
  team_id             uuid         NULL REFERENCES public.cluster4_teams(id) ON DELETE SET NULL,
  source_file_name    text         NULL,
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cluster4_experience_line_masters_team_id_idx
  ON public.cluster4_experience_line_masters (team_id)
  WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cluster4_experience_line_masters_is_active_idx
  ON public.cluster4_experience_line_masters (is_active);

DROP TRIGGER IF EXISTS cluster4_experience_line_masters_set_updated_at
  ON public.cluster4_experience_line_masters;

CREATE TRIGGER cluster4_experience_line_masters_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_line_masters
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

GRANT SELECT ON public.cluster4_experience_line_masters TO anon, authenticated;

COMMENT ON TABLE public.cluster4_experience_line_masters
  IS '실무 경험 라인 코드 마스터. 엑셀 원본의 시트/파일 단위를 1 row 로 관리.';
COMMENT ON COLUMN public.cluster4_experience_line_masters.line_code
  IS '라인 식별 코드 (unique). 예: exp-design, exp-marketing.';
COMMENT ON COLUMN public.cluster4_experience_line_masters.source_file_name
  IS '원본 엑셀 파일명 (import 이력 추적용).';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: cluster4_experience_line_evaluations
-- ═══════════════════════════════════════════════════════════════════════
-- points 컬럼 없음. points = rating (1:1 계산값).

CREATE TABLE IF NOT EXISTS public.cluster4_experience_line_evaluations (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  line_target_id  uuid         NOT NULL
                  REFERENCES public.cluster4_line_targets(id) ON DELETE CASCADE,
  user_id         uuid         NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  rating          smallint     NOT NULL
                  CHECK (rating >= 0 AND rating <= 10),
  evaluated_by    uuid         NULL
                  REFERENCES public.admin_users(id) ON DELETE SET NULL,
  evaluated_at    timestamptz  NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_line_evaluations_target_user_unique
    UNIQUE (line_target_id, user_id)
);

CREATE INDEX IF NOT EXISTS cluster4_experience_line_evaluations_user_id_idx
  ON public.cluster4_experience_line_evaluations (user_id);

CREATE INDEX IF NOT EXISTS cluster4_experience_line_evaluations_line_target_id_idx
  ON public.cluster4_experience_line_evaluations (line_target_id);

DROP TRIGGER IF EXISTS cluster4_experience_line_evaluations_set_updated_at
  ON public.cluster4_experience_line_evaluations;

CREATE TRIGGER cluster4_experience_line_evaluations_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_line_evaluations
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

GRANT SELECT ON public.cluster4_experience_line_evaluations TO anon, authenticated;

COMMENT ON TABLE public.cluster4_experience_line_evaluations
  IS '실무 경험 라인 평가. rating(0~10) = points. 별도 points 컬럼 없음.';
COMMENT ON COLUMN public.cluster4_experience_line_evaluations.rating
  IS '평가 점수 0~10 정수. points = rating (1:1). 표시명은 organization_resume_card_settings.point_label.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: cluster4_lines 확장 — line_code + experience_line_master_id
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS line_code                    text   NULL,
  ADD COLUMN IF NOT EXISTS experience_line_master_id    uuid   NULL;

-- experience_line_master_id FK (guard: skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_lines_experience_line_master_id_fkey'
      AND conrelid = 'public.cluster4_lines'::regclass
  ) THEN
    ALTER TABLE public.cluster4_lines
      ADD CONSTRAINT cluster4_lines_experience_line_master_id_fkey
      FOREIGN KEY (experience_line_master_id)
      REFERENCES public.cluster4_experience_line_masters(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- team_id FK → cluster4_teams (기존 team_id 컬럼에 FK 부여)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_lines_team_id_fkey'
      AND conrelid = 'public.cluster4_lines'::regclass
  ) THEN
    ALTER TABLE public.cluster4_lines
      ADD CONSTRAINT cluster4_lines_team_id_fkey
      FOREIGN KEY (team_id)
      REFERENCES public.cluster4_teams(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS cluster4_lines_line_code_idx
  ON public.cluster4_lines (line_code)
  WHERE line_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS cluster4_lines_experience_line_master_id_idx
  ON public.cluster4_lines (experience_line_master_id)
  WHERE experience_line_master_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: line_code backfill
-- ═══════════════════════════════════════════════════════════════════════

-- 5-1. info / competency: activity_type_id → activity_types.line_code
UPDATE public.cluster4_lines cl
SET line_code = at.line_code
FROM public.activity_types at
WHERE cl.activity_type_id IS NOT NULL
  AND cl.activity_type_id = at.id
  AND cl.line_code IS NULL
  AND cl.part_type IN ('info', 'competency');

-- 5-2. career: career_project_id → career_projects.line_code
UPDATE public.cluster4_lines cl
SET line_code = cp.line_code
FROM public.career_projects cp
WHERE cl.career_project_id IS NOT NULL
  AND cl.career_project_id = cp.id
  AND cp.line_code IS NOT NULL
  AND cl.line_code IS NULL
  AND cl.part_type = 'career';

-- 5-3. experience: experience_line_master_id 연결이 아직 없으므로 skip.
--   Phase 2 (엑셀 import + admin UI) 에서 마스터 생성 후 backfill 예정.


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

-- backfill 원복 (info/competency/career line_code → NULL)
UPDATE public.cluster4_lines SET line_code = NULL;

-- cluster4_lines 확장 컬럼 제거
DROP INDEX IF EXISTS public.cluster4_lines_experience_line_master_id_idx;
DROP INDEX IF EXISTS public.cluster4_lines_line_code_idx;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_team_id_fkey;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_experience_line_master_id_fkey;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS experience_line_master_id,
  DROP COLUMN IF EXISTS line_code;

-- evaluations
DROP TRIGGER IF EXISTS cluster4_experience_line_evaluations_set_updated_at
  ON public.cluster4_experience_line_evaluations;
DROP TABLE IF EXISTS public.cluster4_experience_line_evaluations;

-- line masters
DROP TRIGGER IF EXISTS cluster4_experience_line_masters_set_updated_at
  ON public.cluster4_experience_line_masters;
DROP TABLE IF EXISTS public.cluster4_experience_line_masters;

-- teams
DROP TRIGGER IF EXISTS cluster4_teams_set_updated_at ON public.cluster4_teams;
DROP TABLE IF EXISTS public.cluster4_teams;

COMMIT;
*/
