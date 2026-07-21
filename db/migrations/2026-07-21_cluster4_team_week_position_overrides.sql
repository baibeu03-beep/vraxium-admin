-- 2026-07-21_cluster4_team_week_position_overrides.sql
-- 주차별 (user × week × org × team) 파트/클래스 **관리자 오버라이드** SoT.
--
-- 배경/원칙:
--   · 원본 = user_position_histories(UPH, PMS 이관·read 전용). 관리자 편집값은 UPH 에 직접 쓰지 않는다.
--   · effective = override ?? UPH (조회부 coalesce). PMS 재이관은 UPH 만 갱신 → override 불변(충돌 0).
--   · 한 유저가 같은 주차에 **여러 팀 이력**을 가질 수 있으므로 키에 organization·raw_team 포함.
--   · raw_team/raw_part 는 **비정규화 문자열**(part_id FK 아님) — 파트/팀 rename·삭제에도 과거 이력 안전(UPH 설계 유지).
--   · position_code 는 UPH 와 동일 enum 재사용(신규 enum 금지).
--
-- 무영향(1단계): 성장 verdict(finalizeWeekUws)는 part/class 미소비 · snapshot 은 이번 단계에서 미접촉
--   (crew card builder 는 2단계에서 effective 로 전환 + snapshot version bump 예정 — 그때 invalidate).
-- Idempotent. exec_sql RPC 또는 Supabase SQL Editor 수동 실행.

CREATE TABLE IF NOT EXISTS public.cluster4_team_week_position_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         uuid NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  organization    text NOT NULL,                       -- organization_slug (encre/oranke/phalanx)
  week_id         uuid NULL
                  REFERENCES public.weeks(id) ON DELETE SET NULL,
  week_start_date date NOT NULL,                        -- UPH 와 동일 조인 키(안정)

  raw_team        text NOT NULL,                        -- 주차별 팀(비정규화 문자열)
  raw_part        text NULL,                            -- 주차별 파트(비정규화 문자열; null=파트 미배정)

  position_code   text NOT NULL CHECK (position_code IN (
                    'regular',
                    'advanced_agent',
                    'advanced_part_leader',
                    'operating_team_leader',
                    'operating_ambassador',
                    'operating_club_leader'
                  )),

  created_by      text NULL,                            -- 관리자 식별(현재 인증 구조상 안정적인 text)
  updated_by      text NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- 유저 × 주차 × 조직 × 팀 1행 (upsert conflict key). 복수 팀 이력 허용.
  CONSTRAINT uq_twpo_user_week_org_team UNIQUE (user_id, week_start_date, organization, raw_team)
);

CREATE INDEX IF NOT EXISTS idx_twpo_org_week
  ON public.cluster4_team_week_position_overrides (organization, week_start_date);
CREATE INDEX IF NOT EXISTS idx_twpo_week_team
  ON public.cluster4_team_week_position_overrides (week_start_date, organization, raw_team);

CREATE OR REPLACE FUNCTION public.touch_twpo_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS twpo_set_updated_at ON public.cluster4_team_week_position_overrides;
CREATE TRIGGER twpo_set_updated_at
  BEFORE UPDATE ON public.cluster4_team_week_position_overrides
  FOR EACH ROW EXECUTE FUNCTION public.touch_twpo_updated_at();

GRANT SELECT ON public.cluster4_team_week_position_overrides TO anon, authenticated;
