-- 2026-05-25_fix_activity_started_at_backfill.sql
-- activity_started_at IS NULL 인 전체 사용자 백필.
-- 기존 #22 마이그레이션은 growth_status IS NOT NULL 조건으로 제한했으나,
-- 모든 활동 사용자에게 성장 시작일이 표시되어야 하므로 조건을 제거한다.
--
-- 의존성: #22 (2026-05-25_cluster3_growth_indicators.sql) — activity_started_at 컬럼 존재 가정
-- Idempotent — 이미 적용된 환경에서 다시 실행해도 안전하다.

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 1: 기존 사용자 백필 (growth_status 무관)
-- ═══════════════════════════════════════════════════════════════════════
-- created_at 기준 직전 월요일(ISO week start), midnight KST.

UPDATE public.user_profiles
SET activity_started_at = (
  created_at::date
  - ((EXTRACT(ISODOW FROM created_at::date)::int - 1) || ' days')::interval
  + '00:00:00+09'::time
)
WHERE activity_started_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- STEP 2: 검증 — activity_started_at IS NULL 사용자 수 (0이어야 정상)
-- ═══════════════════════════════════════════════════════════════════════

SELECT
  COUNT(*) AS remaining_null_count
FROM public.user_profiles
WHERE activity_started_at IS NULL;
