-- 2026-05-27_org_settings_add_point_label.sql
-- organization_resume_card_settings 에 point_label 컬럼 추가.
--
-- 배경:
--   실무 경험 평점-포인트 정책 변경: points = rating (1:1 대응).
--   포인트 표시명은 조직별로 다름 (별, 단감, 투구 등).
--   DB 에는 숫자(rating)만 저장하고, UI 표시명은 이 컬럼에서 조회.
--
-- 재실행 안전: ADD COLUMN IF NOT EXISTS + ON CONFLICT DO NOTHING → 멱등.

BEGIN;

ALTER TABLE public.organization_resume_card_settings
  ADD COLUMN IF NOT EXISTS point_label text;

COMMENT ON COLUMN public.organization_resume_card_settings.point_label
  IS '실무 경험 포인트 UI 표시명 (예: 별, 단감, 투구). rating 숫자 뒤에 붙여 표시.';

UPDATE public.organization_resume_card_settings
  SET point_label = '별'
  WHERE organization_slug = 'encre' AND point_label IS NULL;

UPDATE public.organization_resume_card_settings
  SET point_label = '단감'
  WHERE organization_slug = 'oranke' AND point_label IS NULL;

UPDATE public.organization_resume_card_settings
  SET point_label = '투구'
  WHERE organization_slug = 'phalanx' AND point_label IS NULL;

COMMIT;
