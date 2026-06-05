-- 2026-06-05_weeks_check_threshold.sql
-- 주차별 "주차 인정 point.check 기준값" 컬럼.
--
-- 정책 (2026-06-05 레거시 통합 라인 v17 정정):
--   강화 성공 = [실무 경험] 통합 라인 평점 4점 이상 (기존 유지).
--   주차 성공 = 평점 4점 이상 AND 그 주차 point.check(user_weekly_points.points) >= 기준값.
--   advantage / penalty 는 주차 성공 판정에 사용하지 않는다.
--   기준값 NULL = 코드 기본값(DEFAULT_WEEK_CHECK_THRESHOLD=30) 적용.
--
-- 적용 범위: 레거시(허브 도입 전, start_date < 2026-06-29) 주차 판정에서만 소비된다.
--   2026 여름 W1 이후 허브/라인 체계 판정은 이 컬럼을 읽지 않는다.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS check_threshold integer
  CHECK (check_threshold IS NULL OR check_threshold >= 0);

COMMENT ON COLUMN public.weeks.check_threshold IS
  '주차 인정 point.check 기준값. NULL=코드 기본값(30) 적용. 레거시(2026 여름 W1 이전) 통합 라인 주차 성공 판정에 사용 — 평점 4점 이상 AND check >= 기준값이어야 주차 성공.';
