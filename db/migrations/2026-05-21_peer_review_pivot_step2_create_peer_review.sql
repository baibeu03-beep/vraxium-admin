-- 2026-05-21_peer_review_pivot_step2_create_peer_review.sql
-- Front Cluster4 peer-review canonical schema 생성.
-- 선행: 2026-05-21_peer_review_pivot_step1_rename_score_grid.sql (canonical 이름 확보)
--
-- 본 단계는 raw peer-review row storage 만. aggregation/ranking/grade/derived metric/
-- growth stats 는 본 PR 범위 외.
--
-- rate-limit (주차 4/7건, 시즌 10/7건) 은 app 레이어 비즈니스룰 — DB constraint 로 강제 X.
-- 자기리뷰 금지 / (reviewer, target, week|season) 유니크 / 시즌 키워드 3개 distinct 는 DB 에서 강제.
--
-- 키워드 컬럼은 자유 텍스트로 유지 (FK X). taxonomy master 변경이 history row 를 깨지 않도록.

BEGIN;

-- ============================================================
-- reputation_keywords: 5군락 keyword taxonomy 마스터
--   - id 는 uuid (Front API 의 select(*) 응답 shape 가 id:string|number 를 허용)
--   - cluster_number 1..5 (Front 의 5군락 분류)
--   - UNIQUE (keyword) — taxonomy 식별값 중복 금지
-- ============================================================
CREATE TABLE IF NOT EXISTS public.reputation_keywords (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_number  integer      NOT NULL,
  cluster_name    text         NOT NULL,
  cluster_color   text         NOT NULL,
  keyword         text         NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT reputation_keywords_cluster_number_range
    CHECK (cluster_number BETWEEN 1 AND 5),
  CONSTRAINT reputation_keywords_keyword_length
    CHECK (char_length(keyword) BETWEEN 1 AND 30),
  CONSTRAINT reputation_keywords_unique_keyword
    UNIQUE (keyword)
);

CREATE INDEX IF NOT EXISTS reputation_keywords_cluster_idx
  ON public.reputation_keywords (cluster_number, id);

-- ============================================================
-- weekly_reputations: 주차 peer-review row
--   - reviewer 가 target 에 대해 한 주차당 1건 작성 (UNIQUE 강제)
--   - rating: 0..10 의 0.5 단위 (Front /api/weekly-reputations:184)
--   - content: 1..100 자 (Front /api/weekly-reputations:198)
--   - keyword: 자유 텍스트 (UI 는 reputation_keywords 후보에서 선택)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.weekly_reputations (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  reviewer_id     uuid         NOT NULL
                               REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  target_user_id  uuid         NOT NULL
                               REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_card_id    uuid         NOT NULL
                               REFERENCES public.weeks(id) ON DELETE RESTRICT,

  rating          numeric(3,1) NOT NULL,
  content         text         NOT NULL,
  keyword         text         NOT NULL,

  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT weekly_reputations_rating_range_half_step
    CHECK (rating >= 0 AND rating <= 10 AND (rating * 2) = floor(rating * 2)),
  CONSTRAINT weekly_reputations_content_length
    CHECK (char_length(content) BETWEEN 1 AND 100),
  CONSTRAINT weekly_reputations_keyword_nonempty
    CHECK (char_length(keyword) >= 1),
  CONSTRAINT weekly_reputations_no_self_review
    CHECK (reviewer_id <> target_user_id),
  CONSTRAINT weekly_reputations_unique_reviewer_target_week
    UNIQUE (reviewer_id, target_user_id, week_card_id)
);

CREATE INDEX IF NOT EXISTS weekly_reputations_target_week_idx
  ON public.weekly_reputations (target_user_id, week_card_id);

CREATE INDEX IF NOT EXISTS weekly_reputations_reviewer_week_idx
  ON public.weekly_reputations (reviewer_id, week_card_id);

-- ============================================================
-- season_reputations: 시즌 peer-review row
--   - rating: 1..10 의 0.5 단위 (Front /api/season-reputations:179, 0 금지)
--   - content: 1..300 자 (Front /api/season-reputations:193)
--   - keyword_1/2/3 각 1..10 자, 셋 모두 서로 다른 값 (Front:208, 215)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.season_reputations (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  reviewer_id        uuid         NOT NULL
                                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  target_user_id     uuid         NOT NULL
                                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  season_history_id  uuid         NOT NULL
                                  REFERENCES public.user_season_histories(id) ON DELETE RESTRICT,

  rating             numeric(3,1) NOT NULL,
  content            text         NOT NULL,
  keyword_1          text         NOT NULL,
  keyword_2          text         NOT NULL,
  keyword_3          text         NOT NULL,

  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT season_reputations_rating_range_half_step
    CHECK (rating >= 1 AND rating <= 10 AND (rating * 2) = floor(rating * 2)),
  CONSTRAINT season_reputations_content_length
    CHECK (char_length(content) BETWEEN 1 AND 300),
  CONSTRAINT season_reputations_keyword_1_length
    CHECK (char_length(keyword_1) BETWEEN 1 AND 10),
  CONSTRAINT season_reputations_keyword_2_length
    CHECK (char_length(keyword_2) BETWEEN 1 AND 10),
  CONSTRAINT season_reputations_keyword_3_length
    CHECK (char_length(keyword_3) BETWEEN 1 AND 10),
  CONSTRAINT season_reputations_no_self_review
    CHECK (reviewer_id <> target_user_id),
  CONSTRAINT season_reputations_distinct_keywords
    CHECK (keyword_1 <> keyword_2 AND keyword_2 <> keyword_3 AND keyword_1 <> keyword_3),
  CONSTRAINT season_reputations_unique_reviewer_target_season
    UNIQUE (reviewer_id, target_user_id, season_history_id)
);

CREATE INDEX IF NOT EXISTS season_reputations_target_season_idx
  ON public.season_reputations (target_user_id, season_history_id);

CREATE INDEX IF NOT EXISTS season_reputations_reviewer_season_idx
  ON public.season_reputations (reviewer_id, season_history_id);

-- ============================================================
-- updated_at touch triggers
--   - 함수 이름이 step1 직전 admin 의 score-grid migration 의 함수와 동일하지만
--     CREATE OR REPLACE 라 안전. 로직 동일 (NEW.updated_at = now()).
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_weekly_reputations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS weekly_reputations_set_updated_at
  ON public.weekly_reputations;

CREATE TRIGGER weekly_reputations_set_updated_at
BEFORE UPDATE ON public.weekly_reputations
FOR EACH ROW
EXECUTE FUNCTION public.touch_weekly_reputations_updated_at();

CREATE OR REPLACE FUNCTION public.touch_season_reputations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS season_reputations_set_updated_at
  ON public.season_reputations;

CREATE TRIGGER season_reputations_set_updated_at
BEFORE UPDATE ON public.season_reputations
FOR EACH ROW
EXECUTE FUNCTION public.touch_season_reputations_updated_at();

COMMIT;
