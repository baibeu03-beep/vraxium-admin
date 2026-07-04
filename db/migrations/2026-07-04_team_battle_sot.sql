-- 2026-07-04_team_battle_sot.sql
-- Weekly League 상세(/weekly-ranking/[weekId]) "Team Battle" 섹션의 신규 SoT 3종.
--
-- 배경:
--   aggregateWeeklyLeague 가 조직 전체 집계와 같은 기준으로 팀별 대전 결과(teams[])를 산출한다.
--   숫자(성공/실패/도전/휴식/심화·정규)는 기존 테이블(user_week_statuses·user_memberships·
--   user_season_statuses)에서 파생하므로 신규 저장이 필요 없다. 다만 아래 3종은 저장소가 없어
--   신규로 둔다. 이번 단계는 SoT(테이블/컬럼)+DTO(nullable)만 선반영하고, 입력 UI 는 후속.
--
--   1) teamGoal    — 팀 자체 고정 목표. 반기 단위 팀 SoT(cluster4_team_halves)의 컬럼.
--   2) weeklyFlow  — 팀장이 해당 주차에 작성하는 주차 플로우. (team_half, week) 키.
--   3) crewComment — 해당 주차 팀의 크루 코멘트 1건. (team_half, week) 키.
--
-- 무영향: snapshot / user_weekly_points / weekly-cards / demoUserId 경로 미접촉(신규 read 컬럼/테이블).
--   현재 값은 전부 비어 있음 → 집계는 전부 null 로 내려간다(프론트 폴백). 기존 API 응답 불변.
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

-- ═══════════════════════════════════════════════════════════════════════
-- 1) teamGoal — cluster4_team_halves.team_goal (nullable)
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS team_goal text NULL;

COMMENT ON COLUMN public.cluster4_team_halves.team_goal
  IS 'Team Battle 팀 자체 고정 목표(반기 단위). 미입력 시 NULL. 입력 UI 는 후속 단계.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2) weeklyFlow — cluster4_team_weekly_flow  (team_half_id, week_id) 1행
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.cluster4_team_weekly_flow (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  team_half_id   uuid NOT NULL
                 REFERENCES public.cluster4_team_halves(id) ON DELETE CASCADE,
  week_id        uuid NOT NULL
                 REFERENCES public.weeks(id) ON DELETE CASCADE,

  flow_text      text NULL,                    -- 팀장 작성 주차 플로우(미입력 NULL)
  author_user_id uuid NULL                     -- 작성자(팀장) — 후속 입력 UI 에서 기록
                 REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_team_weekly_flow UNIQUE (team_half_id, week_id)
);

CREATE INDEX IF NOT EXISTS idx_team_weekly_flow_week
  ON public.cluster4_team_weekly_flow (week_id);

GRANT SELECT ON public.cluster4_team_weekly_flow TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.touch_cluster4_team_weekly_flow_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS cluster4_team_weekly_flow_set_updated_at
  ON public.cluster4_team_weekly_flow;

CREATE TRIGGER cluster4_team_weekly_flow_set_updated_at
BEFORE UPDATE ON public.cluster4_team_weekly_flow
FOR EACH ROW EXECUTE FUNCTION public.touch_cluster4_team_weekly_flow_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 3) crewComment — cluster4_team_weekly_crew_comment  (team_half_id, week_id) 1행
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.cluster4_team_weekly_crew_comment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  team_half_id   uuid NOT NULL
                 REFERENCES public.cluster4_team_halves(id) ON DELETE CASCADE,
  week_id        uuid NOT NULL
                 REFERENCES public.weeks(id) ON DELETE CASCADE,

  comment_text   text NULL,                    -- 주차 크루 코멘트 1건(미입력 NULL)
  author_user_id uuid NULL
                 REFERENCES public.user_profiles(user_id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_team_weekly_crew_comment UNIQUE (team_half_id, week_id)
);

CREATE INDEX IF NOT EXISTS idx_team_weekly_crew_comment_week
  ON public.cluster4_team_weekly_crew_comment (week_id);

GRANT SELECT ON public.cluster4_team_weekly_crew_comment TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.touch_cluster4_team_weekly_crew_comment_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS cluster4_team_weekly_crew_comment_set_updated_at
  ON public.cluster4_team_weekly_crew_comment;

CREATE TRIGGER cluster4_team_weekly_crew_comment_set_updated_at
BEFORE UPDATE ON public.cluster4_team_weekly_crew_comment
FOR EACH ROW EXECUTE FUNCTION public.touch_cluster4_team_weekly_crew_comment_updated_at();
