-- 2026-06-01_member_roles_uniqueness.sql
-- 멤버 역할(role) 유일성 체계 도입.
--
-- 배경:
--   user_profiles.role 는 이미 존재(2026-05-22_account_management_step1_schema.sql)하며
--   CHECK 로 crew/ambassador/agent/part_leader/team_leader/admin/super_admin 7종을 허용한다.
--   본 마이그레이션은 enum 자체는 건드리지 않고, 아래 운영 규칙을 DB 차원에서 강제한다.
--     - 같은 (organization_slug, current_part_name) 안에 agent 최대 1명
--     - 같은 (organization_slug, current_part_name) 안에 part_leader 최대 1명
--     - 같은 (organization_slug, current_team_name) 안에 team_leader 최대 1명
--
-- 구조적 제약:
--   role 은 user_profiles 에, 팀/파트는 user_memberships(team_name/part_name, is_current)에
--   분리 저장된다. 부분 유니크 인덱스로 보장하려면 현재 소속을 user_profiles 에 비정규화해야 한다.
--   → current_team_name / current_part_name 컬럼을 추가하고,
--     user_memberships 변경 시 트리거로 동기화한다(앱 코드가 아니라 DB 가 단일 소스를 보장).
--
-- 의존: public.user_profiles, public.user_memberships (둘 다 upstream Supabase 에 선존재)
--
-- 재실행 안전: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--             DROP TRIGGER IF EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- ⚠️ 사전 점검 필수:
--   인덱스 생성 전에 같은 (org, part) 에 agent/part_leader 2명 이상,
--   같은 (org, team) 에 team_leader 2명 이상인 기존 위반 데이터가 없어야 한다.
--   위반이 남아 있으면 PART 4 의 CREATE UNIQUE INDEX 단계에서 실패하고 트랜잭션이 롤백된다.
--   (점검 SQL 은 파일 하단 주석 참고)

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 현재 소속 비정규화 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS current_team_name text,
  ADD COLUMN IF NOT EXISTS current_part_name text;

COMMENT ON COLUMN public.user_profiles.current_team_name
  IS 'user_memberships(is_current=true) 의 team_name 비정규화. 트리거로 동기화. 직접 수정 금지.';
COMMENT ON COLUMN public.user_profiles.current_part_name
  IS 'user_memberships(is_current=true) 의 part_name 비정규화. 트리거로 동기화. 직접 수정 금지.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 동기화 함수 + 트리거 (user_memberships → user_profiles.current_*)
-- ═══════════════════════════════════════════════════════════════════════
-- 한 사용자의 is_current=true 멤버십에서 team/part 를 끌어와 user_profiles 에 반영.
-- is_current 행이 여러 개면 updated_at 최신 1건을 기준으로 한다(결정적).
-- is_current 행이 없으면 NULL 로 비운다.

CREATE OR REPLACE FUNCTION public.sync_user_profile_current_membership(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_team text;
  v_part text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT m.team_name, m.part_name
    INTO v_team, v_part
  FROM public.user_memberships m
  WHERE m.user_id = p_user_id
    AND m.is_current = true
  ORDER BY m.updated_at DESC NULLS LAST
  LIMIT 1;

  UPDATE public.user_profiles
    SET current_team_name = v_team,
        current_part_name = v_part
  WHERE user_id = p_user_id
    AND (current_team_name IS DISTINCT FROM v_team
         OR current_part_name IS DISTINCT FROM v_part);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_current_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT/UPDATE 는 NEW.user_id, DELETE 는 OLD.user_id 동기화.
  -- UPDATE 로 user_id 가 바뀌는 경우(드뭄) 양쪽 모두 갱신.
  IF (TG_OP = 'DELETE') THEN
    PERFORM public.sync_user_profile_current_membership(OLD.user_id);
    RETURN OLD;
  END IF;

  IF (TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    PERFORM public.sync_user_profile_current_membership(OLD.user_id);
  END IF;

  PERFORM public.sync_user_profile_current_membership(NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_memberships_sync_current ON public.user_memberships;
CREATE TRIGGER user_memberships_sync_current
  AFTER INSERT OR UPDATE OR DELETE ON public.user_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_current_membership();


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 기존 데이터 백필
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1) current_team_name / current_part_name 백필
--      사용자별 is_current=true 멤버십 중 updated_at 최신 1건.
WITH current_membership AS (
  SELECT DISTINCT ON (m.user_id)
         m.user_id,
         m.team_name,
         m.part_name
  FROM public.user_memberships m
  WHERE m.is_current = true
  ORDER BY m.user_id, m.updated_at DESC NULLS LAST
)
UPDATE public.user_profiles up
  SET current_team_name = cm.team_name,
      current_part_name = cm.part_name
FROM current_membership cm
WHERE up.user_id = cm.user_id
  AND (up.current_team_name IS DISTINCT FROM cm.team_name
       OR up.current_part_name IS DISTINCT FROM cm.part_name);

-- 3-2) role 백필 — role 이 비어 있는(NULL) 일반 멤버만 'crew' 로.
--      admin / super_admin / ambassador / agent / part_leader / team_leader 등
--      이미 값이 있는 사용자는 그대로 보존한다(전체 덮어쓰기 아님).
UPDATE public.user_profiles
  SET role = 'crew'
  WHERE role IS NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 부분 유니크 인덱스 3종
-- ═══════════════════════════════════════════════════════════════════════
-- NULL 인 organization_slug / current_part_name / current_team_name 은
-- Postgres 유니크에서 서로 충돌하지 않는다(파트/팀 미배정자는 자연히 제외됨).
-- 앱 레벨 검증(assertRoleUniqueness)이 1차 방어, 이 인덱스가 동시성/외부 경로의 최종 방어.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_per_part
  ON public.user_profiles (organization_slug, current_part_name)
  WHERE role = 'agent';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_part_leader_per_part
  ON public.user_profiles (organization_slug, current_part_name)
  WHERE role = 'part_leader';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_leader_per_team
  ON public.user_profiles (organization_slug, current_team_name)
  WHERE role = 'team_leader';


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- 사전 점검 SQL (마이그레이션 적용 전 별도 실행 권장)
-- ═══════════════════════════════════════════════════════════════════════
/*
-- ① role 분포
SELECT COALESCE(role, '(null)') AS role, count(*)
FROM public.user_profiles GROUP BY role ORDER BY count DESC;

-- ② is_current 멤버십이 사용자당 1건인지 (2건 이상이면 최신 updated_at 기준 채택됨)
SELECT user_id, count(*) AS current_cnt
FROM public.user_memberships WHERE is_current = true
GROUP BY user_id HAVING count(*) > 1;

-- ③ agent 위반
SELECT up.organization_slug, m.part_name, count(*)
FROM public.user_profiles up
JOIN public.user_memberships m ON m.user_id = up.user_id AND m.is_current = true
WHERE up.role = 'agent'
GROUP BY up.organization_slug, m.part_name HAVING count(*) > 1;

-- ④ part_leader 위반
SELECT up.organization_slug, m.part_name, count(*)
FROM public.user_profiles up
JOIN public.user_memberships m ON m.user_id = up.user_id AND m.is_current = true
WHERE up.role = 'part_leader'
GROUP BY up.organization_slug, m.part_name HAVING count(*) > 1;

-- ⑤ team_leader 위반
SELECT up.organization_slug, m.team_name, count(*)
FROM public.user_profiles up
JOIN public.user_memberships m ON m.user_id = up.user_id AND m.is_current = true
WHERE up.role = 'team_leader'
GROUP BY up.organization_slug, m.team_name HAVING count(*) > 1;
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DROP INDEX IF EXISTS public.uniq_agent_per_part;
DROP INDEX IF EXISTS public.uniq_part_leader_per_part;
DROP INDEX IF EXISTS public.uniq_team_leader_per_team;

DROP TRIGGER IF EXISTS user_memberships_sync_current ON public.user_memberships;
DROP FUNCTION IF EXISTS public.trg_sync_current_membership();
DROP FUNCTION IF EXISTS public.sync_user_profile_current_membership(uuid);

-- 컬럼은 남겨도 무해하나, 완전 롤백 시:
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS current_team_name,
  DROP COLUMN IF EXISTS current_part_name;

-- 주의: role='crew' 백필은 NULL 로 되돌리지 않는다(원래 NULL 이었는지 구분 불가).
--       필요하면 적용 전 user_profiles 스냅샷으로 복원할 것.

COMMIT;
*/
