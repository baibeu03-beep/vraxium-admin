-- =========================================================================
-- ⚠️⚠️ 더미 테스트용 SQL (DUMMY / TEST DATA ONLY) — 운영 환경 실행 금지 ⚠️⚠️
-- =========================================================================
-- 목적: 현재 role='crew' 인 사용자들에게 team_leader / part_leader / agent 를
--       랜덤으로 배정한다. UI/유일성 검증 시연용 더미 데이터이며 운영 배정과 무관.
--
-- 배정 정책 (파트 인원에 따라 다름):
--   1) 동일 사용자가 team_leader / part_leader / agent 를 중복 보유하지 않는다.
--   2) 파트 인원 1명  → part_leader 만 (agent 미배정)
--   3) 파트 인원 2명  → part_leader 1명 + agent 1명
--   4) 파트 인원 3명+ → part_leader 1명 + agent 1명 (team_leader 후보와 겹치지 않게)
--   5) team_leader 는 organization_slug + current_team_name 마다 1명
--   6) current_team_name / current_part_name 이 NULL 인 사용자 제외
--      super_admin 제외(후보를 role='crew' 로 한정 → 자동 제외)
--
-- ★ 파트 식별 기준: (organization_slug, current_team_name, current_part_name)
--   part_name 이 팀별로 재사용되므로(예: '일반' 이 여러 팀에 존재) 팀까지 합쳐야
--   '진짜 파트' 단위가 된다. 이는 2026-06-01_member_roles_part_scope_fix.sql 의
--   부분 유니크 인덱스(org, team, part)와 일치한다.
--
-- 구현 아이디어 — 파트 내 무작위 순위(part_rank)로 역할 풀을 나눈다:
--   · part_rank = 1   → part_leader (파트원 1명 이상이면 항상)
--   · part_rank = 2   → agent       (파트원 2명 이상일 때만 존재 → 조건2 자동 충족)
--   · part_rank >= 3  → team_leader 후보 풀 (파트 역할과 절대 겹치지 않음 → 조건1·4)
--   team_leader 는 팀 내 part_rank>=3 후보(=3명+ 파트의 잉여 인원) 중 무작위 1명.
--
-- ⚠️ 정책의 불가피한 귀결:
--   팀을 구성하는 (실제)파트가 모두 2명 이하면 team_leader 후보(잉여 인원)가 없어
--   해당 팀에는 team_leader 가 배정되지 않는다. (STEP 2 의 "team_leader 미배정 팀"으로 확인)
--
-- 동작 순서: STEP 0(기존 더미 역할 리셋) → STEP 1(배정안 계산·고정)
--            → STEP 2(미리보기) → STEP 3(UPDATE)
--   배정안을 임시 테이블에 1회 계산해 두므로 STEP 2 에서 본 결과가 STEP 3 에 그대로 반영됨.
-- =========================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 0: 기존 더미 역할 리셋 — 재실행 시 잔존 leader 와의 충돌(23505) 방지.
--         team_leader / part_leader / agent 를 모두 crew 로 되돌린다.
--         admin / ambassador / super_admin 은 건드리지 않는다.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.user_profiles
SET role = 'crew'
WHERE role IN ('team_leader', 'part_leader', 'agent');


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 1: 배정안을 임시 테이블에 1회 계산 (미리보기 = 실제 반영 보장)
--         재실행하면 random() 으로 새 배정안이 다시 만들어진다.
-- ─────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS _role_assignment_preview;

CREATE TEMP TABLE _role_assignment_preview AS
WITH eligible AS MATERIALIZED (
  -- 후보: 현재 일반 멤버(crew)이면서 팀/파트가 모두 채워진 사용자
  SELECT user_id, organization_slug, current_team_name, current_part_name
  FROM public.user_profiles
  WHERE role = 'crew'                  -- (조건6) crew 한정 → super_admin/admin/ambassador/기존 직책 자동 제외
    AND current_team_name IS NOT NULL  -- (조건6)
    AND current_part_name IS NOT NULL  -- (조건6)
),
ranked AS MATERIALIZED (
  -- (실제)파트별 인원수(part_size)와 파트 내 무작위 순위(part_rank).
  -- ★ 파트 = (organization_slug, current_team_name, current_part_name)
  SELECT
    user_id,
    organization_slug,
    current_team_name,
    current_part_name,
    count(*) OVER (
      PARTITION BY organization_slug, current_team_name, current_part_name
    ) AS part_size,
    row_number() OVER (
      PARTITION BY organization_slug, current_team_name, current_part_name
      ORDER BY random()
    ) AS part_rank
  FROM eligible
),
-- part_leader = 파트 내 1순위 (파트원 1명 이상이면 항상)
part_leaders AS (
  SELECT user_id, organization_slug, current_team_name, current_part_name, part_size
  FROM ranked
  WHERE part_rank = 1
),
-- agent = 파트 내 2순위 (part_size=1 이면 2순위 행이 없으므로 자동 미배정 → 조건2)
agents AS (
  SELECT user_id, organization_slug, current_team_name, current_part_name, part_size
  FROM ranked
  WHERE part_rank = 2
),
-- team_leader 후보 = 파트 역할(1·2순위)에 안 뽑힌 사람 = 3명+ 파트의 3순위 이후 인원
team_candidates AS MATERIALIZED (
  SELECT
    user_id,
    organization_slug,
    current_team_name,
    current_part_name,
    part_size,
    row_number() OVER (PARTITION BY organization_slug, current_team_name ORDER BY random()) AS team_rank
  FROM ranked
  WHERE part_rank >= 3                  -- (조건1·4) 파트 역할과 절대 겹치지 않는 풀
),
-- team_leader = 팀별 후보 중 무작위 1명 (조건5)
team_leaders AS (
  SELECT user_id, organization_slug, current_team_name, current_part_name, part_size
  FROM team_candidates
  WHERE team_rank = 1
)
SELECT user_id, organization_slug, current_team_name, current_part_name, part_size,
       'part_leader' AS assigned_role
  FROM part_leaders
UNION ALL
SELECT user_id, organization_slug, current_team_name, current_part_name, part_size,
       'agent'
  FROM agents
UNION ALL
SELECT user_id, organization_slug, current_team_name, current_part_name, part_size,
       'team_leader'
  FROM team_leaders;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 2: 미리보기
-- ─────────────────────────────────────────────────────────────────────────

-- (2-A) 각 파트별 배정 결과 — part_leader / agent / 비고를 한 줄로 확인  ★요청 사항★
--       파트 = (org, team, part)
SELECT
  a.organization_slug,
  a.current_team_name,
  a.current_part_name,
  a.part_size,
  max(CASE WHEN a.assigned_role = 'part_leader' THEN up.display_name END) AS part_leader,
  max(CASE WHEN a.assigned_role = 'agent'       THEN up.display_name END) AS agent,
  CASE
    WHEN a.part_size = 1 THEN '1인 파트 → agent 미배정'
    WHEN a.part_size = 2 THEN '2인 파트 → part_leader + agent'
    ELSE '3인+ 파트 → part_leader + agent (+팀장 후보 잉여)'
  END AS note
FROM _role_assignment_preview a
JOIN public.user_profiles up ON up.user_id = a.user_id
WHERE a.assigned_role IN ('part_leader', 'agent')
GROUP BY a.organization_slug, a.current_team_name, a.current_part_name, a.part_size
ORDER BY a.organization_slug, a.current_team_name, a.current_part_name;

-- (2-B) 팀별 team_leader 배정 결과
SELECT
  a.organization_slug,
  a.current_team_name,
  up.display_name AS team_leader,
  a.current_part_name AS picked_from_part
FROM _role_assignment_preview a
JOIN public.user_profiles up ON up.user_id = a.user_id
WHERE a.assigned_role = 'team_leader'
ORDER BY a.organization_slug, a.current_team_name;

-- (2-C) team_leader 미배정 팀 — 소속 (실제)파트가 모두 2인 이하라 후보가 없는 팀
SELECT DISTINCT
  e.organization_slug,
  e.current_team_name
FROM public.user_profiles e
WHERE e.role = 'crew'
  AND e.current_team_name IS NOT NULL
  AND e.current_part_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM _role_assignment_preview a
    WHERE a.assigned_role = 'team_leader'
      AND a.organization_slug IS NOT DISTINCT FROM e.organization_slug
      AND a.current_team_name = e.current_team_name
  )
ORDER BY e.organization_slug, e.current_team_name;

-- (2-D) 전체 배정 목록 (역할 단위 상세)
SELECT a.assigned_role, a.organization_slug, a.current_team_name,
       a.current_part_name, a.part_size, a.user_id, up.display_name
FROM _role_assignment_preview a
JOIN public.user_profiles up ON up.user_id = a.user_id
ORDER BY a.organization_slug, a.current_team_name, a.current_part_name,
         CASE a.assigned_role WHEN 'team_leader' THEN 1 WHEN 'part_leader' THEN 2 ELSE 3 END;

-- (검증 ①) 한 사용자가 2개 이상 배정됐는지 — 0행이어야 정상 (조건1)
SELECT user_id, count(*) AS role_cnt
FROM _role_assignment_preview
GROUP BY user_id
HAVING count(*) > 1;

-- (검증 ②) (org, team, part) 당 part_leader/agent 가 2명 이상인지 — 0행이어야 정상
SELECT organization_slug, current_team_name, current_part_name, assigned_role, count(*)
FROM _role_assignment_preview
WHERE assigned_role IN ('part_leader', 'agent')
GROUP BY organization_slug, current_team_name, current_part_name, assigned_role
HAVING count(*) > 1;

-- (검증 ③) 역할별 배정 인원 요약
SELECT assigned_role, count(*) AS assigned_users
FROM _role_assignment_preview
GROUP BY assigned_role
ORDER BY assigned_role;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 3: 실제 반영 — STEP 2 에서 본 배정안 그대로 UPDATE
--         (그룹별 1명씩이므로 부분 유니크 인덱스 위반 23505 없이 적용됨)
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.user_profiles up
SET role = a.assigned_role
FROM _role_assignment_preview a
WHERE up.user_id = a.user_id;


-- (선택) 임시 테이블 정리 — 세션 종료 시 자동 삭제되지만 명시도 가능
-- DROP TABLE IF EXISTS _role_assignment_preview;


-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (더미 배정 되돌리기) — 배정된 역할을 다시 crew 로 복구
--   admin / ambassador / super_admin 은 건드리지 않는다.
-- ─────────────────────────────────────────────────────────────────────────
/*
UPDATE public.user_profiles
SET role = 'crew'
WHERE role IN ('team_leader', 'part_leader', 'agent');
*/
