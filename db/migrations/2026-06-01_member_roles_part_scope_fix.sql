-- 2026-06-01_member_roles_part_scope_fix.sql
-- 역할 유일성 인덱스 입자(granularity) 보정.
--
-- 배경:
--   2026-06-01_member_roles_uniqueness.sql 는 agent/part_leader 유일성을
--   (organization_slug, current_part_name) 기준으로 잡았다.
--   그러나 실데이터에서 part_name 이 조직 내 유일하지 않고 팀별로 재사용된다.
--     예) phalanx 의 '일반' → IT / 브랜딩 / 서비스 3개 팀에서 공용
--         encre 의 '일반'   → A&R / 비주얼 2개 팀에서 공용
--   이 경우 서로 다른 팀의 동명 파트가 하나로 병합되어, 한 팀만 part_leader/agent 를
--   가질 수 있고 나머지 팀의 동명 파트는 영원히 배정 불가(23505 위반)가 된다.
--
-- 변경:
--   agent / part_leader 유일성 기준을
--     (organization_slug, current_part_name)
--   에서
--     (organization_slug, current_team_name, current_part_name)
--   으로 변경한다(팀 + 파트 = 실제 파트 단위).
--   team_leader 는 팀 단위 역할이므로 (organization_slug, current_team_name) 그대로 유지.
--
-- 의존: 2026-06-01_member_roles_uniqueness.sql (컬럼/인덱스 선존재)
--
-- 안전성:
--   새 인덱스는 기존보다 더 "촘촘한" 기준이다. 기존 coarse 인덱스가 이미
--   (org, part) 당 ≤1 을 보장했으므로 (org, team, part) 당으로도 ≤1 이 보장된다.
--   → 기존 데이터로 인한 CREATE UNIQUE INDEX 실패 위험 없음.
--   재실행 안전: DROP INDEX IF EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS.

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 기존 (org, part) 입자 인덱스 제거
-- ═══════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS public.uniq_agent_per_part;
DROP INDEX IF EXISTS public.uniq_part_leader_per_part;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: (org, team, part) 입자 인덱스 신설
-- ═══════════════════════════════════════════════════════════════════════
-- NULL 인 organization_slug / current_team_name / current_part_name 은
-- Postgres 유니크에서 서로 충돌하지 않는다(미배정자는 자연히 제외됨).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_per_team_part
  ON public.user_profiles (organization_slug, current_team_name, current_part_name)
  WHERE role = 'agent';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_part_leader_per_team_part
  ON public.user_profiles (organization_slug, current_team_name, current_part_name)
  WHERE role = 'part_leader';

-- team_leader 인덱스(uniq_team_leader_per_team)는 변경하지 않는다.


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- 사전 점검 SQL (적용 전 별도 실행 권장 — 새 입자 기준 위반이 없어야 함)
-- ═══════════════════════════════════════════════════════════════════════
/*
-- agent 위반 (새 기준)
SELECT organization_slug, current_team_name, current_part_name, count(*)
FROM public.user_profiles
WHERE role = 'agent'
GROUP BY organization_slug, current_team_name, current_part_name
HAVING count(*) > 1;

-- part_leader 위반 (새 기준)
SELECT organization_slug, current_team_name, current_part_name, count(*)
FROM public.user_profiles
WHERE role = 'part_leader'
GROUP BY organization_slug, current_team_name, current_part_name
HAVING count(*) > 1;
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시 — 다시 (org, part) 입자로 되돌림)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DROP INDEX IF EXISTS public.uniq_agent_per_team_part;
DROP INDEX IF EXISTS public.uniq_part_leader_per_team_part;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_per_part
  ON public.user_profiles (organization_slug, current_part_name)
  WHERE role = 'agent';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_part_leader_per_part
  ON public.user_profiles (organization_slug, current_part_name)
  WHERE role = 'part_leader';

COMMIT;
*/
