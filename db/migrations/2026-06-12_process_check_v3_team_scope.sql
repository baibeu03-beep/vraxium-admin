-- 2026-06-12_process_check_v3_team_scope.sql
-- 프로세스 체크 — 팀 스코프 추가(experience 허브). ADDITIVE — v2 적용 위에 덧입힘(데이터 보존).
--
-- 배경:
--   실무 경험 급(experience)은 팀별 탭이 있고, 같은 액트라도 팀마다 체크 상태가 독립이어야 한다
--   (라이프 팀 '시작 알림' 완료 ↔ 미디어 팀 '시작 알림' 필요). 따라서 체크 상태/로그에 team_id 추가.
--   ⚠ info/competency 등 팀 구분 없는 허브는 team_id = NULL(허브 전체 1행) 그대로.
--
--   user_weekly_points · snapshot · checkGate · process_acts 마스터 무접촉. write 는 service_role 만.
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

-- ── 상태: team_id(nullable) ───────────────────────────────────────────────────
ALTER TABLE public.process_check_statuses ADD COLUMN IF NOT EXISTS team_id uuid NULL;

-- 기존 UNIQUE(org,hub,week,act) 제약을 제거하고, team_id 를 포함한 UNIQUE 인덱스로 교체한다.
--   team_id NULL(info 등)은 NULL 들이 서로 distinct 로 취급되어 중복 허용되므로 COALESCE 센티넬로 접는다.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'public.process_check_statuses'::regclass AND contype = 'u'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.process_check_statuses DROP CONSTRAINT ' || quote_ident(c);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS process_check_statuses_scope_team_uq
  ON public.process_check_statuses (
    organization_slug, hub, week_id, act_id,
    COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_process_check_statuses_team
  ON public.process_check_statuses (organization_slug, hub, week_id, team_id);

COMMENT ON COLUMN public.process_check_statuses.team_id IS
  'experience 허브 팀 스코프(cluster4_teams.id). 팀 구분 없는 허브는 NULL(허브 전체 1행).';

-- ── 로그: team_id + team_name(denorm) ─────────────────────────────────────────
ALTER TABLE public.process_check_logs ADD COLUMN IF NOT EXISTS team_id uuid NULL;
ALTER TABLE public.process_check_logs ADD COLUMN IF NOT EXISTS team_name text NULL;

COMMENT ON COLUMN public.process_check_logs.team_name IS
  '로그 표시용 팀명(denorm·쓰기 시점). 팀 구분 없는 허브는 NULL(로그에 팀 세그먼트 생략).';

-- PostgREST 스키마 캐시 즉시 리로드(신규 컬럼이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name FROM information_schema.columns
 WHERE table_name='process_check_statuses' AND column_name='team_id';
SELECT indexname FROM pg_indexes
 WHERE tablename='process_check_statuses' AND indexname LIKE '%scope_team_uq';
*/
