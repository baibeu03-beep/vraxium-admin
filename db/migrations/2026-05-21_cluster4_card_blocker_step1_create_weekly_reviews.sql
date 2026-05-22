-- 2026-05-21_cluster4_card_blocker_step1_create_weekly_reviews.sql
-- Cluster4-card 주차별 본인 회고(weekly_reviews) canonical 테이블 생성.
--
-- 배경:
--   Career-Resume/backend/database/schema/weekly_reviews.sql 의 기존 FK 가
--   `REFERENCES public.user_profiles (id)` 로 표기되어 있었으나, user_profiles
--   의 canonical PK 는 `user_id` 이므로(`lib/get-user-profile.ts` 의 alias 헬퍼
--   참조) 적용 시점에 FK 가 실패했다. 운영 DB 점검 결과 본 테이블은 미존재였고,
--   Front `/api/weekly-reviews` 가 silent fail 상태였다.
--   본 migration 은 정정된 FK 로 canonical 테이블을 새로 도입한다.
--
-- 정합성:
--   - Career-Resume/app/api/weekly-reviews/route.ts (GET/POST)
--   - Career-Resume/app/api/weekly-reviews/[id]/route.ts (PUT/DELETE)
--   에서 입력 검증 rating 1..10 정수, content 1..200 자, UNIQUE(user_id, week_card_id).
--
-- 비범위:
--   - aggregation/ranking/derived metric — 별도 PR
--   - RLS 정책 — 본 migration 그룹의 컨벤션에 따라 별도 정책 미부여
--     (write 는 service_role 경유, 운영 DB 의 PostgREST 노출 정책으로 별도 보호)
--   - admin 대필 작성 라우트 보강 — 별도 PR

BEGIN;

-- ============================================================
-- weekly_reviews: 주차별 본인 회고
--   - 본인 1 명이 하나의 week_card_id 에 대해 1 건만 보유 (UNIQUE 강제)
--   - rating: 1..10 정수 (Front `app/api/weekly-reviews/route.ts:120-124`)
--   - content: 1..200 자 (Front `app/api/weekly-reviews/route.ts:131-143`)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.weekly_reviews (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       uuid         NOT NULL
                             REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_card_id  uuid         NOT NULL
                             REFERENCES public.weeks(id) ON DELETE RESTRICT,

  rating        smallint     NOT NULL,
  content       text         NOT NULL,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT weekly_reviews_rating_range
    CHECK (rating BETWEEN 1 AND 10),
  CONSTRAINT weekly_reviews_content_length
    CHECK (char_length(content) BETWEEN 1 AND 200),
  CONSTRAINT weekly_reviews_unique_user_week
    UNIQUE (user_id, week_card_id)
);

CREATE INDEX IF NOT EXISTS weekly_reviews_user_idx
  ON public.weekly_reviews (user_id);

CREATE INDEX IF NOT EXISTS weekly_reviews_week_idx
  ON public.weekly_reviews (week_card_id);

-- ============================================================
-- updated_at touch trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_weekly_reviews_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS weekly_reviews_set_updated_at
  ON public.weekly_reviews;

CREATE TRIGGER weekly_reviews_set_updated_at
BEFORE UPDATE ON public.weekly_reviews
FOR EACH ROW
EXECUTE FUNCTION public.touch_weekly_reviews_updated_at();

COMMIT;
