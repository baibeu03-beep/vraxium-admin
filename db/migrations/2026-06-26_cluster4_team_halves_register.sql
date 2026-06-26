-- 2026-06-26_cluster4_team_halves_register.sql
-- 반기별 팀 SoT(cluster4_team_halves)에 팀 등록 팝업용 컬럼 추가.
--   · description     : 팀 개요(최대 200자 — 검증은 앱 레이어).
--   · leader_user_id  : 팀장(이미 등록된 크루의 user_profiles.user_id). ON DELETE SET NULL.
--   · leader_crew_code: 등록 시점 팀장 크루코드 스냅샷(표시/추적용).
--
-- SoT 원칙: 팀 반기 SoT 는 cluster4_team_halves 그대로(역산 금지). 팀장 인물 정보는
--   조회 시 기존 크루/프로필 SoT(getCrewDetailDto + getClubRankGradeBatch)에서 가져온다
--   — 여기엔 식별자(user_id)+코드 스냅샷만 보관.
-- 무영향: snapshot / weekly-cards / demoUserId 경로 미접촉.
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS description text NULL;

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS leader_user_id uuid NULL
    REFERENCES public.user_profiles(user_id) ON DELETE SET NULL;

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS leader_crew_code text NULL;

CREATE INDEX IF NOT EXISTS idx_team_halves_leader
  ON public.cluster4_team_halves (leader_user_id);
