-- 2026-05-21_user_activity_details_add_rating.sql
-- user_activity_details.rating 컬럼 신설 (Work Exp 모달 rating 0~10 저장 경로).
--
-- 배경:
--   Cluster4-card Work Exp 모달의 `workExpRating` slider state 가 Front 에 존재하나
--   `POST /api/activity-details` payload 에 rating 키가 없어 silent drop 상태였음
--   (`claudedocs/cluster4-card-final-data-model-design-20260521.md` §4.4).
--   본 컬럼 추가로 Admin / Front 양쪽이 동일한 컬럼에 read/write 한다.
--
-- 정책:
--   - rating IS NULL OR (rating BETWEEN 0 AND 10) — 0 허용, 정수 제약 없음
--     (Front slider 는 정수 step 으로만 노출되지만, schema 상으로는 smallint 범위).
--   - Work Info / Work Ability 의 row 에서는 rating 을 NULL 로 둔다.
--   - Admin 측 PATCH (lib/adminCluster4Data.ts) 에서 activity_type 분기 시 적용.
--
-- 비범위:
--   - 기존 row backfill — rating 컬럼은 nullable 이므로 기존 row 영향 없음.
--   - Front payload 확장 — Career-Resume 측 별도 PR.
--
-- 재실행 안전:
--   - ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.

BEGIN;

ALTER TABLE public.user_activity_details
  ADD COLUMN IF NOT EXISTS rating smallint NULL;

ALTER TABLE public.user_activity_details
  DROP CONSTRAINT IF EXISTS user_activity_details_rating_range;

ALTER TABLE public.user_activity_details
  ADD CONSTRAINT user_activity_details_rating_range
  CHECK (
    rating IS NULL
    OR (rating >= 0 AND rating <= 10)
  );

COMMIT;
