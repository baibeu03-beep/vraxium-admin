-- 2026-06-01_user_profiles_status_growth_check.sql
-- status/growth_status 분리 3단계: CHECK 제약 추가 (데이터 변경 없음, 제약만 추가).
--   - user_profiles.status      = 계정 활성 전용: 'active' | 'inactive'
--   - user_profiles.growth_status = 성장 상태 7종(또는 NULL)
-- 멱등: 동일 이름 제약이 이미 있으면 추가하지 않는다(pg_constraint 가드 → 중복 생성 금지).
-- 선행: 1단계(코드 enum 분리)·2단계(status 오염값 active 백필) 완료 전제.
--   적용 시점 데이터: status=active 121 / growth_status ∈ {active,seasonal_rest,graduating,graduated,paused}
--   → 두 CHECK 모두 기존 데이터를 위반하지 않음(사전 검증 완료).
--
-- 적용: Supabase SQL Editor 에서 본 파일 전체 실행.

-- ── (선행 점검) 기존 동일/유사 CHECK 존재 여부 확인용 SELECT ──────────
--   실행 전 아래로 현재 제약을 확인할 수 있다(참고용, 실행은 선택):
-- SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--  WHERE conrelid = 'public.user_profiles'::regclass AND contype = 'c';

-- ── status CHECK ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_profiles_status_check'
       AND conrelid = 'public.user_profiles'::regclass
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_status_check
      CHECK (status IN ('active', 'inactive'));
    RAISE NOTICE 'added user_profiles_status_check';
  ELSE
    RAISE NOTICE 'user_profiles_status_check already exists — skipped';
  END IF;
END $$;

-- ── growth_status CHECK ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_profiles_growth_status_check'
       AND conrelid = 'public.user_profiles'::regclass
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_growth_status_check
      CHECK (
        growth_status IS NULL OR growth_status IN (
          'active',
          'weekly_rest',
          'seasonal_rest',
          'paused',
          'suspended',
          'graduating',
          'graduated'
        )
      );
    RAISE NOTICE 'added user_profiles_growth_status_check';
  ELSE
    RAISE NOTICE 'user_profiles_growth_status_check already exists — skipped';
  END IF;
END $$;

-- ── 적용 후 검증 ─────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--  WHERE conrelid = 'public.user_profiles'::regclass
--    AND conname IN ('user_profiles_status_check','user_profiles_growth_status_check');

-- ── 롤백 SQL ─────────────────────────────────────────────────────────
-- ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_status_check;
-- ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_growth_status_check;
