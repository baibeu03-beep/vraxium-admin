-- 2026-06-26_cluster4_team_parts.sql
-- 팀별 파트 카탈로그 — 팀 등록 시 자동 생성되는 "일반" 파트의 백엔드 SoT.
--
-- 배경:
--   기존에 파트는 카탈로그가 없고 user_memberships.part_name 으로만 암묵 존재했다
--   (동명 파트가 팀별로 재사용 — 2026-06-01_member_roles_part_scope_fix.sql 참고).
--   팀 box 의 "일반" 파트는 소속 크루가 0명이어도 데이터로 보장돼야 하므로(예비 파트·미삭제)
--   팀(cluster4_team_halves 행)에 귀속되는 최소 카탈로그를 둔다.
--
-- 정책:
--   · 모든 팀은 생성 즉시 is_default=true("일반") 파트 1개를 가진다(registerTeamHalf 가 보장).
--   · UNIQUE(team_half_id, part_name) → 같은 팀에 동명 파트 중복 불가(idempotent upsert).
--   · "일반" 파트의 기본 파트장 = 팀장(leader_user_id). 삭제 금지(앱 레이어 가드).
--   · 파트 "수/이름" 표시는 현재 주차 user_memberships 점유 기준으로 파생하고,
--     점유 파트가 없으면 이 카탈로그의 "일반"을 노출(min 1) — 본 테이블은 일반 보장·메타용.
--
-- 무영향: snapshot / weekly-cards / demoUserId 경로 미접촉(신규 보조 테이블).
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.cluster4_team_parts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  team_half_id    uuid NOT NULL
                  REFERENCES public.cluster4_team_halves(id) ON DELETE CASCADE,
  part_name       text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,   -- "일반" = true (예비 파트·미삭제)
  leader_user_id  uuid NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,
  display_order   integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_team_part UNIQUE (team_half_id, part_name)
);

CREATE INDEX IF NOT EXISTS idx_team_parts_team
  ON public.cluster4_team_parts (team_half_id);

GRANT SELECT ON public.cluster4_team_parts TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.touch_cluster4_team_parts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_team_parts_set_updated_at
  ON public.cluster4_team_parts;

CREATE TRIGGER cluster4_team_parts_set_updated_at
BEFORE UPDATE ON public.cluster4_team_parts
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_team_parts_updated_at();

-- 기존에 등록된 팀(register 컬럼 마이그레이션 이후 생성분)에 "일반" 파트 백필.
--   leader_user_id = 팀의 leader_user_id. 이미 있으면 미변경(idempotent).
INSERT INTO public.cluster4_team_parts (team_half_id, part_name, is_default, leader_user_id, display_order)
SELECT th.id, '일반', true, th.leader_user_id, 0
FROM public.cluster4_team_halves th
ON CONFLICT (team_half_id, part_name) DO NOTHING;
