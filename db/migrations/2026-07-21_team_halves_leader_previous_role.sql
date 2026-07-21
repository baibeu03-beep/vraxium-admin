-- 2026-07-21_team_halves_leader_previous_role.sql
-- 팀장 역할 lifecycle — "팀장 승격 직전 role" 결정적 보존 컬럼.
--
-- 배경/원칙:
--   · 팀 리더 지정 시 user_profiles.role 을 'team_leader' 로 승격한다(집계·카드·[B] 클래스가 모두
--     user_profiles.role 을 읽으므로 이 한 컬럼으로 정합). 교체/삭제로 내려올 때 정확히 복원해야 한다.
--   · 복원 소스 = 이 컬럼(leader_previous_role) = 그 리더가 팀장이 되기 직전에 갖고 있던 role 스냅샷.
--     팀별 저장이라 다중 팀장 케이스도 정확. NULL = 레거시(승격 이력 없음) → 임의 강등 금지·수동 검토.
--   · 감사 이력은 기존 공식 SoT user_role_audit(old_role→new_role) 재사용(병행).
--   · user_position_histories(주차별, PMS 소유)는 이 lifecycle 과 무관 — 절대 미변경(현재 role 축과 분리).
--
-- Idempotent. exec_sql RPC 부재 → Supabase SQL Editor 수동 실행.

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS leader_previous_role text NULL;

COMMENT ON COLUMN public.cluster4_team_halves.leader_previous_role IS
  '이 팀 리더가 team_leader 로 승격되기 직전의 user_profiles.role 스냅샷. 교체/삭제로 팀장에서 내려올 때 결정적 복원 소스(다른 active 팀 리더면 team_leader 유지). user_role_audit(감사)와 병행. NULL=레거시(복원 근거 없음).';
