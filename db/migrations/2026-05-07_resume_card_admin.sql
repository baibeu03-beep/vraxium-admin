-- 2026-05-07_resume_card_admin.sql
-- resume-card admin 도메인용 신규 테이블 3종 + seed.
-- 기존 user_profiles / user_educations / user_memberships / user_introductions 는
-- 컬럼 변경 없이 그대로 사용한다.
-- Supabase SQL Editor에서 그대로 실행할 수 있다.
-- Idempotent — 이미 적용된 환경에서 다시 실행해도 안전하다.
--
-- 의존성: 2026-05-05_admin_crew_management.sql, 2026-05-05_organization_aware_crew.sql
--          (user_profiles 테이블이 있어야 user_resume_card_settings의 FK가 성립)

-- ─────────────────────────────────────────────────────────────────────
-- 0. 공통 updated_at 트리거 함수 (이미 있으면 재정의)
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. user_resume_card_settings (per-user override, 1:1 with user_profiles)
--    크루별 hexagon 링크, 도움말 툴팁, 메달 주차 override.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_resume_card_settings (
  user_id              uuid PRIMARY KEY
                       REFERENCES public.user_profiles(user_id)
                       ON DELETE CASCADE,
  hexagon_link_1       text,
  hexagon_link_2       text,
  hexagon_link_3       text,
  help_tooltip_text    text,
  medal_week_override  smallint
                       CHECK (medal_week_override IS NULL OR medal_week_override >= 0),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid
);

DROP TRIGGER IF EXISTS user_resume_card_settings_set_updated_at
  ON public.user_resume_card_settings;

CREATE TRIGGER user_resume_card_settings_set_updated_at
BEFORE UPDATE ON public.user_resume_card_settings
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 2. organization_resume_card_settings (per-club)
--    클럽별 메달 테마, 상단 notice 문구/도장.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_resume_card_settings (
  organization_slug           text PRIMARY KEY
                              CHECK (organization_slug IN ('encre','oranke','phalanx')),
  medal_theme                 text CHECK (medal_theme IN ('OK','EC','PX')),
  notice_top_text             text,
  notice_top_stamp_image_url  text,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid
);

DROP TRIGGER IF EXISTS organization_resume_card_settings_set_updated_at
  ON public.organization_resume_card_settings;

CREATE TRIGGER organization_resume_card_settings_set_updated_at
BEFORE UPDATE ON public.organization_resume_card_settings
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Seed: 3 클럽 + 메달 테마 매핑.
INSERT INTO public.organization_resume_card_settings (organization_slug, medal_theme)
VALUES
  ('encre',   'EC'),
  ('oranke',  'OK'),
  ('phalanx', 'PX')
ON CONFLICT (organization_slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 3. site_resume_card_settings (singleton, id=1 강제)
--    하단 notice 문구/도장, 글로벌 도움말 툴팁 default.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_resume_card_settings (
  id                              smallint PRIMARY KEY CHECK (id = 1),
  notice_bottom_text              text,
  notice_bottom_stamp_image_url   text,
  help_tooltip_default            text,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid
);

DROP TRIGGER IF EXISTS site_resume_card_settings_set_updated_at
  ON public.site_resume_card_settings;

CREATE TRIGGER site_resume_card_settings_set_updated_at
BEFORE UPDATE ON public.site_resume_card_settings
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Seed: id=1 singleton row.
INSERT INTO public.site_resume_card_settings (id, notice_bottom_text)
VALUES (1, '전국청춘성장 클럽 - 기업/실무자 후원 관리 위원회')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. 권한
--    User App(anon/authenticated)은 read만, write는 service_role(supabaseAdmin)
--    이 admin API를 경유한다. 별도 RLS 정책은 두지 않는다.
-- ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON public.user_resume_card_settings         TO anon, authenticated;
GRANT SELECT ON public.organization_resume_card_settings TO anon, authenticated;
GRANT SELECT ON public.site_resume_card_settings         TO anon, authenticated;
