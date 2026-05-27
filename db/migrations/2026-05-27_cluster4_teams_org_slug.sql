-- 2026-05-27_cluster4_teams_org_slug.sql
-- cluster4_teams 를 조직별 팀 마스터로 재구성.
--
-- 변경:
--   1) organization_slug 컬럼 추가 (text NOT NULL, default 'phalanx')
--   2) 기존 UNIQUE(team_name) → UNIQUE(organization_slug, team_name) 으로 교체
--   3) 잘못 seed 된 조직명 row (encre, oranke) 삭제
--   4) 기존 IT/브랜딩/서비스 → phalanx 소속으로 보정
--   5) 3개 조직의 실제 팀 seed
--
-- 배경:
--   Phase 1 seed 가 legacy_crew_import.team_name 을 그대로 가져와서
--   조직명(encre, oranke)이 팀명으로 잘못 들어갔다.
--   실무 경험 라인은 조직별 팀에 연결되므로 organization_slug 가 필요하다.
--
-- 의존: 2026-05-27_cluster4_experience_phase1.sql (cluster4_teams 테이블 존재)
--
-- 재실행 안전: ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING, guarded DELETE.

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: organization_slug 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_teams
  ADD COLUMN IF NOT EXISTS organization_slug text;

-- 기존 row 에 default 값 채우기 (NOT NULL 전환 전)
UPDATE public.cluster4_teams
  SET organization_slug = 'phalanx'
  WHERE organization_slug IS NULL;

-- NOT NULL 제약 (idempotent: 이미 NOT NULL 이면 무시)
DO $$
BEGIN
  ALTER TABLE public.cluster4_teams
    ALTER COLUMN organization_slug SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- DEFAULT 설정 (seed 이후 수동 insert 시 편의)
ALTER TABLE public.cluster4_teams
  ALTER COLUMN organization_slug SET DEFAULT 'phalanx';

COMMENT ON COLUMN public.cluster4_teams.organization_slug
  IS '소속 조직 (encre / oranke / phalanx). 팀명은 조직 내에서만 unique.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: UNIQUE 제약 교체 — team_name → (organization_slug, team_name)
-- ═══════════════════════════════════════════════════════════════════════

-- 기존 team_name UNIQUE 제약 제거
ALTER TABLE public.cluster4_teams
  DROP CONSTRAINT IF EXISTS cluster4_teams_team_name_key;

-- 새 복합 UNIQUE 추가 (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_teams_org_team_unique'
      AND conrelid = 'public.cluster4_teams'::regclass
  ) THEN
    ALTER TABLE public.cluster4_teams
      ADD CONSTRAINT cluster4_teams_org_team_unique
      UNIQUE (organization_slug, team_name);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- organization_slug 기반 조회 인덱스
CREATE INDEX IF NOT EXISTS cluster4_teams_org_slug_idx
  ON public.cluster4_teams (organization_slug);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 잘못 seed 된 조직명 row 삭제
-- ═══════════════════════════════════════════════════════════════════════
-- encre, oranke 가 팀명으로 들어간 경우 제거.
-- FK 참조(cluster4_experience_line_masters.team_id, cluster4_lines.team_id) 가
-- 이 row 를 참조하고 있으면 ON DELETE SET NULL 로 안전하게 해제됨.

DELETE FROM public.cluster4_teams
  WHERE team_name IN ('encre', 'oranke')
    AND NOT EXISTS (
      SELECT 1 FROM public.cluster4_experience_line_masters
      WHERE team_id = cluster4_teams.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.cluster4_lines
      WHERE team_id = cluster4_teams.id
    );

-- FK 참조가 있어도 삭제해야 하는 경우 (SET NULL 처리 후 삭제)
UPDATE public.cluster4_experience_line_masters
  SET team_id = NULL
  WHERE team_id IN (
    SELECT id FROM public.cluster4_teams WHERE team_name IN ('encre', 'oranke')
  );

UPDATE public.cluster4_lines
  SET team_id = NULL
  WHERE team_id IN (
    SELECT id FROM public.cluster4_teams WHERE team_name IN ('encre', 'oranke')
  );

DELETE FROM public.cluster4_teams
  WHERE team_name IN ('encre', 'oranke');


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 기존 row 조직 보정 (IT/브랜딩/서비스 → phalanx)
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.cluster4_teams
  SET organization_slug = 'phalanx'
  WHERE team_name IN ('IT', '브랜딩', '서비스')
    AND organization_slug <> 'phalanx';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: 조직별 팀 seed
-- ═══════════════════════════════════════════════════════════════════════

-- encre (5팀)
INSERT INTO public.cluster4_teams (organization_slug, team_name) VALUES
  ('encre', '비주얼'),
  ('encre', '갤러리'),
  ('encre', 'A&R'),
  ('encre', '프로듀싱'),
  ('encre', '팬마케팅')
ON CONFLICT (organization_slug, team_name) DO NOTHING;

-- oranke (5팀)
INSERT INTO public.cluster4_teams (organization_slug, team_name) VALUES
  ('oranke', 'F&B'),
  ('oranke', '콘텐츠'),
  ('oranke', '엔터테인먼트'),
  ('oranke', '커머스'),
  ('oranke', '스타일')
ON CONFLICT (organization_slug, team_name) DO NOTHING;

-- phalanx (3팀) — 기존 row 있으면 skip
INSERT INTO public.cluster4_teams (organization_slug, team_name) VALUES
  ('phalanx', 'IT'),
  ('phalanx', '브랜딩'),
  ('phalanx', '서비스')
ON CONFLICT (organization_slug, team_name) DO NOTHING;


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DELETE FROM public.cluster4_teams
  WHERE organization_slug IN ('encre', 'oranke')
    AND team_name NOT IN ('IT', '브랜딩', '서비스');

ALTER TABLE public.cluster4_teams
  DROP CONSTRAINT IF EXISTS cluster4_teams_org_team_unique;

DROP INDEX IF EXISTS public.cluster4_teams_org_slug_idx;

ALTER TABLE public.cluster4_teams
  ALTER COLUMN organization_slug DROP NOT NULL,
  ALTER COLUMN organization_slug DROP DEFAULT;

ALTER TABLE public.cluster4_teams
  DROP COLUMN IF EXISTS organization_slug;

ALTER TABLE public.cluster4_teams
  ADD CONSTRAINT cluster4_teams_team_name_key UNIQUE (team_name);

COMMIT;
*/
