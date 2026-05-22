-- 2026-05-22_cluster4_card_base_step1_user_activity_details.sql
-- Cluster4-card 활동 모달 데이터 canonical 테이블(user_activity_details) 생성.
-- (rating 컬럼 / 0..10 CHECK / scope UNIQUE 를 처음부터 포함.)
--
-- 배경:
--   Cluster4-card 의 Work Info / Work Ability / Work Exp / Work Career 모달이 공유하는
--   user_activity_details 테이블이 어느 repo 의 schema 에도 정의되지 않아 운영 DB 에 미생성
--   상태였다. 따라서 `db/migrations/2026-05-21_user_activity_details_add_rating.sql` 의
--   ALTER 역시 base 부재로 적용 실패. 본 migration 이 canonical base 를 도입하고 rating
--   컬럼 및 0..10 CHECK 까지 한 번에 적용한다.
--
-- 정합성:
--   - `lib/userActivityDetailsTypes.ts` (canonical 컬럼/제약 문서)
--   - `lib/userActivityDetailsData.ts` SELECT 컬럼:
--       id,user_id,week_id,activity_type_id,sub_title,output_links,growth_point,
--       image_urls,image_captions,growth_image_url,growth_image_caption,rating,
--       created_at,updated_at
--   - upsert onConflict scope = (user_id, week_id, activity_type_id) — UNIQUE 로 보장
--   - rating: smallint NULL, 0..10 (workexp 전용; info/ability/career 에서는 NULL)
--
-- FK 정책:
--   - user_profiles(user_id)  ON DELETE CASCADE — 사용자 탈퇴 시 활동 자동 제거
--   - weeks(id)               ON DELETE RESTRICT — 주차 카드 정의는 강제 보존
--   - activity_types(id) FK 는 두지 않는다.
--     activity_type_id 는 `classifyActivityType` 의 prefix 분류(info/comp-/exp-/car-) 로
--     모달을 결정하는 자유 텍스트 키이며, activity_types row 가 완비된다는 보장이 없다.
--     UI fallback(미상 → work_info) 도 코드측에서 처리하므로 FK 미적용이 안전하다.
--
-- 비범위:
--   - 기존 row backfill — 신규 테이블이므로 해당 없음
--   - RLS — 본 migration 그룹 컨벤션 (service_role 전용 write)
--   - text length / array length CHECK — 코드측 validation 으로 위임
--
-- 재실행 안전:
--   - CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
--   - DROP TRIGGER IF EXISTS + CREATE TRIGGER

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_activity_details (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id               uuid         NOT NULL
                                     REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_id               uuid         NOT NULL
                                     REFERENCES public.weeks(id) ON DELETE RESTRICT,

  activity_type_id      text         NOT NULL,

  sub_title             text         NULL,
  output_links          jsonb        NOT NULL DEFAULT '[]'::jsonb,
  growth_point          text         NULL,
  image_urls            text[]       NOT NULL DEFAULT '{}',
  image_captions        text[]       NOT NULL DEFAULT '{}',
  growth_image_url      text         NULL,
  growth_image_caption  text         NULL,
  rating                smallint     NULL,

  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT user_activity_details_rating_range
    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  CONSTRAINT user_activity_details_unique_scope
    UNIQUE (user_id, week_id, activity_type_id)
);

CREATE INDEX IF NOT EXISTS user_activity_details_user_idx
  ON public.user_activity_details (user_id);

CREATE INDEX IF NOT EXISTS user_activity_details_user_week_idx
  ON public.user_activity_details (user_id, week_id);

CREATE INDEX IF NOT EXISTS user_activity_details_activity_type_idx
  ON public.user_activity_details (activity_type_id);

-- ============================================================
-- updated_at touch trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_user_activity_details_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_activity_details_set_updated_at
  ON public.user_activity_details;

CREATE TRIGGER user_activity_details_set_updated_at
BEFORE UPDATE ON public.user_activity_details
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_activity_details_updated_at();

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TRIGGER IF EXISTS user_activity_details_set_updated_at ON public.user_activity_details;
DROP FUNCTION IF EXISTS public.touch_user_activity_details_updated_at();
DROP TABLE IF EXISTS public.user_activity_details;
COMMIT;
*/
