-- 2026-06-15_process_check_v4_part_scope.sql
-- 프로세스 체크 — 파트 스코프 추가(experience 허브). ADDITIVE — v2/v3 위에 덧입힘(데이터 보존).
--
-- 배경:
--   실무 경험 급(experience)은 팀 탭 아래 "팀 & 파트" 드롭다운(팀 전체/팀 총괄/파트…)이 있고,
--   파트 목록은 실제 팀 구조(user_memberships.part_name)에서 온다(process_line_groups 아님).
--   process_acts 에는 part_id 가 없어, 액트의 "파트 여부"만 라인급명("파트" 포함)으로 판정한다.
--   따라서 같은 파트 액트라도 파트마다 체크 상태가 독립이어야 한다
--     (브랜딩 파트 '체크 신청' ↔ 콘텐츠/운영 파트 '체크 필요'). → 체크 상태/로그에 part_name 추가.
--   ⚠ team_overall(팀 총괄)/info 등은 part_name = NULL(파트 미구분). team_all(팀 전체)은 읽기 전용 집계.
--
--   user_weekly_points · snapshot · checkGate · process_acts 마스터 무접촉. write 는 service_role 만.
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

-- ── 상태: part_name(nullable) ─────────────────────────────────────────────────
ALTER TABLE public.process_check_statuses ADD COLUMN IF NOT EXISTS part_name text NULL;

-- v3 의 (org,hub,week,act,team) UNIQUE 인덱스를 (… , part_name) 포함으로 교체한다.
--   part_name NULL(팀 총괄/info)은 NULL 들이 서로 distinct 로 취급되므로 COALESCE 빈문자 센티넬로 접는다.
DROP INDEX IF EXISTS public.process_check_statuses_scope_team_uq;

CREATE UNIQUE INDEX IF NOT EXISTS process_check_statuses_scope_team_part_uq
  ON public.process_check_statuses (
    organization_slug, hub, week_id, act_id,
    COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(part_name, '')
  );

CREATE INDEX IF NOT EXISTS idx_process_check_statuses_team_part
  ON public.process_check_statuses (organization_slug, hub, week_id, team_id, part_name);

COMMENT ON COLUMN public.process_check_statuses.part_name IS
  'experience 허브 파트 스코프(user_memberships.part_name). 팀 총괄/info 등은 NULL(파트 미구분).';

-- ── 로그: part_name(denorm) ───────────────────────────────────────────────────
ALTER TABLE public.process_check_logs ADD COLUMN IF NOT EXISTS part_name text NULL;

COMMENT ON COLUMN public.process_check_logs.part_name IS
  '로그 표시용 파트명(denorm·쓰기 시점). 팀 총괄/info 등은 NULL(로그에 파트 세그먼트 생략).';

-- PostgREST 스키마 캐시 즉시 리로드(신규 컬럼이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name FROM information_schema.columns
 WHERE table_name='process_check_statuses' AND column_name='part_name';
SELECT indexname FROM pg_indexes
 WHERE tablename='process_check_statuses' AND indexname LIKE '%scope_team_part_uq';
-- 같은 (org,hub,week,act,team) 에 파트별 독립 행 가능 확인:
SELECT team_id, part_name, status FROM public.process_check_statuses
 WHERE hub='experience' ORDER BY team_id, part_name;
*/
