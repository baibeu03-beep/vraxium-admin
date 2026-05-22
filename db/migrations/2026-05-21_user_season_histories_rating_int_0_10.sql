-- 2026-05-21_user_season_histories_rating_int_0_10.sql
-- user_season_histories.rating CHECK 제약을 정수 0..10 으로 재정의.
--
-- 변경 배경:
--   기존 제약 `user_season_histories_rating_check` 는 admin probing 결과
--   `rating IS NULL OR (rating >= 0 AND rating <= 5)` 로 추정됨 (실수도 허용).
--   운영 정책 확정: 0..10 정수만 허용 / null 허용 / 소수점 불가.
--
-- 안전성:
--   - 컬럼 type 은 numeric 유지 (data type migration 회피).
--   - 기존 비-null row 1건(rating=5)만 존재 — 새 제약 만족 → ADD 시 검증 통과.
--   - 향후 비-정수 데이터가 우회 경로로 들어와도 ADD 단계에서 즉시 fail 하도록
--     NOT VALID 옵션은 쓰지 않음 (정합성 우선).
--
-- 재실행 안전:
--   - DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT (고정 이름) → 멱등.

BEGIN;

ALTER TABLE public.user_season_histories
  DROP CONSTRAINT IF EXISTS user_season_histories_rating_check;

ALTER TABLE public.user_season_histories
  ADD CONSTRAINT user_season_histories_rating_check
  CHECK (
    rating IS NULL
    OR (
      rating >= 0
      AND rating <= 10
      AND rating = floor(rating)
    )
  );

COMMIT;
