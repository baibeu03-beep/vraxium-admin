-- 2026-06-26_user_season_statuses_active.sql
-- user_season_statuses.status 에 'active'(시즌 참여/활동) 허용 추가.
--
-- 배경: user_season_statuses 를 "시즌 참여 단일 SoT" 로 확장한다. 2026 여름 운영 대상자(318)는
--   모두 1행을 갖는다 — active(활동/운영진/검수/기타) · rest(시즌 전체 휴식) · stopped(중단).
--   /admin/members 모집단 = operationalSeasonKey 행 보유자(= 해당 시즌 운영 대상자)로 좁힌다.
--   'active' 는 멤버십 마커일 뿐 — displayGrowthStatus(휴식/중단 외)는 기존 성장 계산을 따른다.
--   growth_status 무수정 · 과거 시즌 무소급.
--
-- 적용: Supabase SQL Editor 수동 실행. Idempotent. (선행: 2026-06-26_user_season_statuses_stopped.sql)

DO $$
DECLARE
  cn   text;
  cdef text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid)
    INTO cn, cdef
    FROM pg_constraint
   WHERE conrelid = 'public.user_season_statuses'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%'
   ORDER BY conname
   LIMIT 1;

  IF cn IS NULL THEN
    ALTER TABLE public.user_season_statuses
      ADD CONSTRAINT user_season_statuses_status_check
      CHECK (status IN ('success', 'rest', 'stopped', 'active'));
    RAISE NOTICE 'added user_season_statuses_status_check (success/rest/stopped/active)';

  ELSIF cdef ILIKE '%active%' THEN
    RAISE NOTICE 'skip: % already allows active -> %', cn, cdef;

  ELSE
    EXECUTE format('ALTER TABLE public.user_season_statuses DROP CONSTRAINT %I', cn);
    ALTER TABLE public.user_season_statuses
      ADD CONSTRAINT user_season_statuses_status_check
      CHECK (status IN ('success', 'rest', 'stopped', 'active'));
    RAISE NOTICE 'recreated % to allow active (was: %)', cn, cdef;
  END IF;
END $$;

-- 확인: SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.user_season_statuses'::regclass AND contype='c';
