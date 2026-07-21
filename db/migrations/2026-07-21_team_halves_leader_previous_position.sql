-- 2026-07-21_team_halves_leader_previous_position.sql
-- 팀장 역할 lifecycle — "팀장 승격 직전 포지션" 결정적 보존(JSONB 스냅샷).
--
-- 배경(검증으로 규명된 실제 모델):
--   · "팀장" = user_profiles.role='team_leader' AND current_team_name=담당 팀명(결합). 부분 유니크 인덱스
--     uniq_team_leader_per_team(organization_slug, current_team_name) = (org,팀명)당 팀장 1명.
--   · 따라서 팀장 지정은 역할 변경이 아니라 **역할 + 현재 팀 소속(current_team_name) 동시 정합** 작업.
--     agent/part_leader 복원은 current_part_name 까지 필요 → role 하나만으론 정확 복원 불가.
--   · 승격 직전 {role, teamName, partName} 을 JSONB 로 보존해 교체/삭제 시 정확히 되돌린다.
--   · 감사 = user_role_audit(기존 공식 SoT) 재사용. user_position_histories(주차·PMS)·user_memberships 미변경.
--
-- 1차 임시 컬럼 leader_previous_role(text) 은 이 스냅샷으로 대체(제거). Idempotent. Supabase SQL Editor 수동 실행.

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS leader_previous_position jsonb NULL;

ALTER TABLE public.cluster4_team_halves
  DROP COLUMN IF EXISTS leader_previous_role;

COMMENT ON COLUMN public.cluster4_team_halves.leader_previous_position IS
  '이 팀 리더가 team_leader 로 승격되기 직전의 포지션 스냅샷 {role, teamName, partName}. 교체/삭제로 팀장에서 내려올 때 결정적 복원 소스(다른 active 팀 리더면 team_leader 유지). NULL=레거시(복원 근거 없음).';
