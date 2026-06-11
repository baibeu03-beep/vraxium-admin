-- 2026-06-09_cluster4_weekly_ranking_exceptions.sql
-- weekly-ranking 봄 정합용 "공식 + 봄 전용 예외 보정" SoT.
--
-- 목적 (claudedocs/weekly-ranking-spring-exception-design-20260609.md):
--   2026 ORANKE 봄 W1~W13 weekly-ranking 표시 집계를 PMS /WeeklyReport 실측과 100% 일치.
--   전체 숫자 하드코딩 없이, 설명 가능한 공식의 "입력값"만 예외로 보정한다.
--
-- 허용 예외 2종 (그 외 금지):
--   1) confirm_star_override : 해당 (org, week) 의 effectiveConfirmStar 를 int_value 로 대체
--      (예: W1 첫 주차 실제 통과선 51. user_id NULL = 주차 레벨)
--   2) cohort_exclude        : 해당 (org, week, user) 를 코호트에서 제외
--      (예: 유현준 W9~W11 — PA공모전 소급입력으로 그 주차 시점 점수 미달, PMS 활동 대상자 아님)
--   ※ total/success/fail/rest 직접 override 는 본 테이블로 표현 불가(의도). 결과 숫자 하드코딩 차단.
--
-- 스코프/비활성화:
--   - lib 는 WHERE organization_slug=org AND season_key={그 카드 season_key} 로만 적재.
--   - 예외 행은 season_key='2026-spring' + 봄 week_id 전용 → 여름(다른 season_key)은 매칭 0 → 기본 공식만.
--     여름부터 Vraxium uws/uwp/cluster4_weekly_pms_activity 단독 SoT, 보정 자동 소멸.
--
-- 무영향: user_week_statuses / user_weekly_points / cluster-4 개인 카드 / snapshot 미변경(READ only 소비).
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.cluster4_weekly_ranking_exceptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL
                    CHECK (organization_slug IN ('encre', 'oranke', 'phalanx')),
  season_key        text NOT NULL,                      -- '2026-spring' (여름 비활성 키)

  week_id           uuid NOT NULL
                    REFERENCES public.weeks(id) ON DELETE CASCADE,
  user_id           uuid NULL                           -- NULL = 주차 레벨(confirm_star_override)
                    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  exception_type    text NOT NULL
                    CHECK (exception_type IN ('confirm_star_override', 'cohort_exclude')),
  int_value         integer NULL,                       -- confirm_star_override 전용(예: 51)
  reason            text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- 타입별 형태 강제: override=주차레벨+값필수 / exclude=유저필수+값없음
  CONSTRAINT cwre_shape CHECK (
    (exception_type = 'confirm_star_override' AND user_id IS NULL     AND int_value IS NOT NULL)
    OR
    (exception_type = 'cohort_exclude'        AND user_id IS NOT NULL AND int_value IS NULL)
  )
);

-- 멱등 키: (org, season, week, user, type) 1행. user_id NULL 도 유일하게(주차레벨 override 1행).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cwre_key
  ON public.cluster4_weekly_ranking_exceptions
     (organization_slug, season_key, week_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), exception_type);

CREATE INDEX IF NOT EXISTS cwre_lookup_idx
  ON public.cluster4_weekly_ranking_exceptions (organization_slug, season_key);

CREATE OR REPLACE FUNCTION public.touch_cluster4_weekly_ranking_exceptions_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_weekly_ranking_exceptions_set_updated_at
  ON public.cluster4_weekly_ranking_exceptions;
CREATE TRIGGER cluster4_weekly_ranking_exceptions_set_updated_at
  BEFORE UPDATE ON public.cluster4_weekly_ranking_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_cluster4_weekly_ranking_exceptions_updated_at();

COMMENT ON TABLE public.cluster4_weekly_ranking_exceptions IS
  'weekly-ranking 봄 정합 예외 보정. confirm_star_override(주차 통과선 대체) / cohort_exclude(대상자 제외)만 허용 — 결과 숫자 하드코딩 불가. season_key 게이트로 여름 자동 비활성. uws/uwp/개인카드/snapshot 무관(READ only).';
COMMENT ON COLUMN public.cluster4_weekly_ranking_exceptions.int_value IS
  'confirm_star_override 의 effectiveConfirmStar 대체값(예: W1=51). cohort_exclude 는 NULL.';
COMMENT ON COLUMN public.cluster4_weekly_ranking_exceptions.reason IS
  '예외 근거(감사용). 예: PA공모전 소급입력으로 그 주차 시점 점수 미달.';
