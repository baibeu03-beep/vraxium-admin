-- 2026-07-21_user_week_grade_histories.sql
-- 주차별 **확정 품계 이력** SoT — "N주차 검수/공표 당시 이 크루가 몇 품이었는가".
--
-- 배경/원칙:
--   · 현재 품계(user_grade_stats + getClubRank*)와 **역할 분리**: 이 테이블은 특정 주차의 확정 품계.
--     현재 품계를 대체하지 않는다(roster/profile 은 그대로 user_grade_stats).
--   · 값 = getClubRank 공통 산식(weekly_score→주차RANK→백분위→온보딩 제외 평균)을 **as-of 주차(≤N)로
--     윈도우**하여 산출. math fork 금지(cluster3ClubRankData 코어 재사용).
--   · 저장 시점 = 주차 검수/공표 확정(runWeeklyCardFinalization). 재검수/재확정 시 (user_id, week_start_date)
--     UPSERT 로 최신 확정값 갱신 = "해당 주차 최종 확정값"(완전 immutable 아님).
--   · undo(집계 중 복원) 시 이 행은 **삭제하지 않는다** — reviewCompleted=false 면 조회부 게이트가 숨김,
--     이후 재확정이 같은 행을 덮어씀.
--   · 품계는 **전역 상대 순위**라 organization 무관 단일값 → org 는 UNIQUE 키에 넣지 않는다(조회 편의 컬럼).
--   · operating(실유저)·qa(테스트유저) 코호트는 test_user_markers 로 disjoint → 키 충돌 없음. scope 는 기록용.
--
-- Idempotent. exec_sql RPC 부재 → Supabase SQL Editor 수동 실행.

CREATE TABLE IF NOT EXISTS public.user_week_grade_histories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         uuid NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  week_start_date date NOT NULL,                        -- 조회/조인 축(카드 startDate·[B] weekStart 동일)
  season_key      text NOT NULL,                        -- 그 주차 시즌(제외 population 재현·조회 편의)
  week_number     int  NOT NULL,                        -- 시즌상대 주차번호(표시 편의)

  avg_percentile  numeric(5,2) NULL,                    -- as-of 평균 백분위(null=이력부재/모집단제외)
  grade           int NULL CHECK (grade IS NULL OR grade BETWEEN 1 AND 10),
  grade_label     text NULL,                            -- "정승"/"정 N품"

  scope           text NOT NULL DEFAULT 'operating'
                    CHECK (scope IN ('operating', 'qa')),
  organization_slug text NULL,                          -- 계산 시점 프로필 org(denormalized, nullable)
  source          text NOT NULL DEFAULT 'finalize'
                    CHECK (source IN ('finalize', 'backfill')),
  finalized_at    timestamptz NULL,                     -- 그 주차 공표/재확정 시각(감사)

  created_by      text NULL,
  updated_by      text NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- 유저 × 주차 1행(품계=전역 단일값). upsert conflict key.
  CONSTRAINT uq_uwgh_user_week UNIQUE (user_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_uwgh_week
  ON public.user_week_grade_histories (week_start_date);
CREATE INDEX IF NOT EXISTS idx_uwgh_user
  ON public.user_week_grade_histories (user_id);

CREATE OR REPLACE FUNCTION public.touch_uwgh_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uwgh_set_updated_at ON public.user_week_grade_histories;
CREATE TRIGGER uwgh_set_updated_at
  BEFORE UPDATE ON public.user_week_grade_histories
  FOR EACH ROW EXECUTE FUNCTION public.touch_uwgh_updated_at();

GRANT SELECT ON public.user_week_grade_histories TO anon, authenticated;
