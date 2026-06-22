-- 2026-06-22_user_position_histories.sql
-- 시즌/주차 단위 직책(포지션) 이력 SoT — 이력서 resume-activities 시즌별 포지션 계산용.
--
-- 배경:
--   user_memberships 는 유저당 1행(현재 상태)만 보유 → 과거 시즌 직책 이력 없음.
--   기존 cluster1ResumeData.computeSeasonRecords 는 현재 직책을 모든 과거 시즌에 복사하는 버그.
--   PMS(MySQL) useractivities 가 유저×주차 단위로 (UserLevel/UserTeam/UserPart) 를 보존 →
--   주차별 실제 직책을 복원할 수 있는 유일한 SoT. (oranke/encre(hrdb)/phalanx(olympus) 커버)
--
-- 직책 우선순위(낮음→높음):
--   regular(일반·정규)
--   < advanced_agent(심화·에이전트) = advanced_part_leader(심화·파트장)
--   < operating_team_leader(운영진·팀장) = operating_ambassador(운영진·앰배서더)
--   < operating_club_leader(운영진·클럽장)
--
-- 디코드 규칙(useractivities, 키워드 스캔 — 컬럼 스왑/오타/공백 내성):
--   '앰배서더' → operating_ambassador
--   '팀장'/'팀장진' → operating_team_leader
--   '클럽' → operating_club_leader   (PMS 주차데이터엔 미발견 — 안전망)
--   '파트장' → advanced_part_leader
--   '에이전트' → advanced_agent
--   '심화' → advanced_agent          (심화 기본 = 에이전트)
--   그 외 → regular
--
-- 매핑:
--   season_key/week = useractivities.StartDate → Vraxium weeks.start_date 매칭(날짜 기반·견고).
--   user = users(source_system, legacy_user_id=PMS UserID) 복합키.
--
-- 무영향: snapshot / user_week_statuses / user_weekly_points / 허브카드 미접촉(이 테이블은 read 전용 소비).
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.user_position_histories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id           uuid NOT NULL
                    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  organization      text NULL,            -- organization_slug (oranke/encre/phalanx)

  -- 주차 차원 (week_id 는 매핑되면 채움, season_key/week_start_date 는 항상 채움)
  season_key        text NULL,
  week_id           uuid NULL REFERENCES public.weeks(id) ON DELETE SET NULL,
  week_number       smallint NULL,
  week_start_date   date NOT NULL,

  -- 직책
  position_code     text NOT NULL
                    CHECK (position_code IN (
                      'regular',
                      'advanced_agent',
                      'advanced_part_leader',
                      'operating_team_leader',
                      'operating_ambassador',
                      'operating_club_leader'
                    )),

  -- provenance / 감사
  source            text NOT NULL DEFAULT 'pms_useractivities',
  source_ref        text NULL,            -- PMS useractivities.ActivityId
  source_system     text NULL,            -- 'oranke' | 'hrdb' | 'olympus'
  legacy_user_id    integer NULL,
  raw_level         text NULL,            -- useractivities.UserLevel (디코드 원본)
  raw_team          text NULL,            -- useractivities.UserTeam
  raw_part          text NULL,            -- useractivities.UserPart

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- 유저×주차 1행 (재이관 시 upsert 대상)
  CONSTRAINT uq_user_position_week UNIQUE (user_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_uph_user_season
  ON public.user_position_histories (user_id, season_key);
CREATE INDEX IF NOT EXISTS idx_uph_user_week
  ON public.user_position_histories (user_id, week_start_date);
