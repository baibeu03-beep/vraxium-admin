-- 2026-06-XX_growth_status_legacy_null_backfill.sql (초안 — 승인 후 날짜 확정)
-- legacy growth_status NULL 백필 + CHECK 축소. dry-run: scripts/dryrun-legacy-growth-status-null.ts
-- 전제: auto/override 분리(54c6c0f) 배포 후. 표시 무영향(대상 전원 override=null 실측).
BEGIN;

-- 롤백용 백업 (실행 전 결과를 별도 보관)
-- SELECT user_id, growth_status FROM public.user_profiles
--  WHERE growth_status IN ('graduating','seasonal_rest','weekly_rest');

UPDATE public.user_profiles
   SET growth_status = NULL
 WHERE growth_status IN ('graduating','seasonal_rest','weekly_rest');
-- 기대 행수: 16 (dry-run 2026-06-07 기준)

ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_growth_status_check;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_growth_status_check
  CHECK (growth_status IS NULL OR growth_status IN ('active','paused','suspended','graduated'));

COMMIT;

-- 롤백: 위 백업 SELECT 결과로 행별 UPDATE 복원 후,
-- CHECK 를 2026-06-01_user_profiles_status_growth_check.sql 의 7종 집합으로 재생성.
