-- 2026-07-02_cluster4_week_opening_configs.sql
-- 클럽 정보 > 주차 내역 > 활동 관리 페이지의 "허브/라인 오픈 설정"(체크 상태) 저장 테이블.
--
-- 목적:
--   주차(week) × 클럽(organization) 별로 "이번 주 활동하는 허브/라인" 체크 상태를 저장하고,
--   [오픈 확인] 여부(open_confirmed)를 기록한다.
--
-- 정책:
--   - config(jsonb) = { practicalInfo:{lineId:bool}, practicalExperience:{teamId:{derive,analysis,research,management,expansion}}, practicalCompetency:{checked} }
--   - open_confirmed = [오픈 확인] 저장 시 true (검수(review)와 별개 — review 는 weeks.result_reviewed_at).
--   - snapshot/재계산 무관 — 조회 화면 및 오픈 설정 상태만 보관.
--
-- 재실행 안전: CREATE TABLE IF NOT EXISTS, guarded trigger.
-- 미적용 시: API 는 저장 config 없음 = 기본 정책값(computed defaults)으로 graceful degrade.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_week_opening_configs (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id            uuid         NOT NULL,
  organization_slug  text         NOT NULL
                       CHECK (organization_slug IN ('encre','oranke','phalanx')),
  config             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  open_confirmed     boolean      NOT NULL DEFAULT false,
  open_confirmed_at  timestamptz  NULL,
  open_confirmed_by  uuid         NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_week_opening_configs_week_org_uq
    UNIQUE (week_id, organization_slug)
);

CREATE INDEX IF NOT EXISTS cluster4_week_opening_configs_week_idx
  ON public.cluster4_week_opening_configs (week_id);

-- updated_at 트리거(step1_tables 에서 생성된 공용 함수 재사용).
DROP TRIGGER IF EXISTS cluster4_week_opening_configs_set_updated_at
  ON public.cluster4_week_opening_configs;

CREATE TRIGGER cluster4_week_opening_configs_set_updated_at
BEFORE UPDATE ON public.cluster4_week_opening_configs
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

GRANT SELECT ON public.cluster4_week_opening_configs TO anon, authenticated;

COMMENT ON TABLE public.cluster4_week_opening_configs
  IS '주차×클럽 허브/라인 오픈 설정(체크 상태) + 오픈 확인 여부. 활동 관리 페이지 전용.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;
DROP TRIGGER IF EXISTS cluster4_week_opening_configs_set_updated_at
  ON public.cluster4_week_opening_configs;
DROP TABLE IF EXISTS public.cluster4_week_opening_configs;
COMMIT;
*/
