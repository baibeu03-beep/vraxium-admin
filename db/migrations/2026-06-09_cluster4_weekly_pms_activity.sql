-- 2026-06-09_cluster4_weekly_pms_activity.sql
-- weekly-ranking 전용: PMS useractivities(활동내역 제출) 신호 보존.
--
-- 목적 (claudedocs/weekly-ranking-w13-scoped-apply-design-20260609.md):
--   weekly-ranking 집계를 PMS 활동인정값과 정합하기 위해 "활동 제출 + 평점(Star)" 신호를 보존한다.
--   성공 공식(집계 전용):
--     success = uws.status='success'
--            OR (user_activity_submitted AND user_activity_star>=4
--                AND uwp.points >= confirmStar AND NOT isRest)
--     코호트 = uws행 존재 OR uwp.points>=confirmStar OR personal_rest
--
-- confirmStar SoT (신규 컬럼 추가 안 함):
--   = org_week_thresholds.check_threshold (이미 weekssettings.confirmStar 백필값, org×week).
--     해석순서: org_week_thresholds(week,org) → weeks.check_threshold → 30. oranke W13=37 확인됨.
--
-- 스코프 = 데이터-게이트: 본 테이블에 행이 존재하는 (org, week) 에만 weekly-league 새 공식 적용.
--   행이 없는 주차/org 는 현행 동작(uws.status 버킷팅) 유지. → oranke W13 만 ingest 하면 W13 만 변경.
--
-- manageractivities 는 분리 보존(코호트 참고용 manager_activity_submitted) — 성공판정에는 미사용.
--
-- 무영향: user_week_statuses / user_weekly_points / cluster-4 개인 카드 / snapshot 미변경(READ only 소비).
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.cluster4_weekly_pms_activity (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id                     uuid NOT NULL
                              REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  year                        smallint NOT NULL,
  week_number                 smallint NOT NULL
                              CHECK (week_number >= 1 AND week_number <= 53),
  week_start_date             date NOT NULL,
  season_key                  text NULL,

  -- 이관 provenance (legacy_point_ledger / org_week_thresholds 동일 계약)
  source_system               text NULL,      -- 'oranke' | 'hrdb' | 'olympus'
  legacy_user_id              integer NULL,

  -- 활동 신호 (useractivities only)
  user_activity_submitted     boolean NOT NULL DEFAULT false,  -- 해당 주차 useractivities 행 존재
  user_activity_star          smallint NULL,                   -- MAX(useractivities.Star) (미제출 NULL)
  user_activity_is_active     boolean NOT NULL DEFAULT false,  -- IsActive=1 존재 (참고용·성공판정 미사용)
  manager_activity_submitted  boolean NOT NULL DEFAULT false,  -- manageractivities 존재 (코호트용·성공판정 미사용)

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, year, week_number)
);

CREATE INDEX IF NOT EXISTS cluster4_weekly_pms_activity_week_idx
  ON public.cluster4_weekly_pms_activity (week_start_date);
CREATE INDEX IF NOT EXISTS cluster4_weekly_pms_activity_user_idx
  ON public.cluster4_weekly_pms_activity (user_id);

CREATE OR REPLACE FUNCTION public.touch_cluster4_weekly_pms_activity_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_weekly_pms_activity_set_updated_at
  ON public.cluster4_weekly_pms_activity;
CREATE TRIGGER cluster4_weekly_pms_activity_set_updated_at
  BEFORE UPDATE ON public.cluster4_weekly_pms_activity
  FOR EACH ROW EXECUTE FUNCTION public.touch_cluster4_weekly_pms_activity_updated_at();

COMMENT ON TABLE public.cluster4_weekly_pms_activity IS
  'weekly-ranking 전용 PMS useractivities 제출/평점 신호. 데이터-게이트 스코프(행 존재 org×week 만 새 공식 적용). manageractivities 분리(성공판정 미사용). confirmStar=org_week_thresholds.check_threshold 재사용. uws/uwp/개인카드/snapshot 무관(READ only).';
COMMENT ON COLUMN public.cluster4_weekly_pms_activity.user_activity_star IS
  'MAX(useractivities.Star) — 평점 SoT. 성공 조건 user_activity_star>=4 에 사용. manageractivities.Star 미포함.';
COMMENT ON COLUMN public.cluster4_weekly_pms_activity.manager_activity_submitted IS
  'manageractivities 존재 여부 — 코호트 산정 참고용. 성공판정에는 사용하지 않는다.';
