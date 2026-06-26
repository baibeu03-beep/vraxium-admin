-- 2026-06-26_user_season_statuses_stopped.sql
-- user_season_statuses.status 에 'stopped'(시즌 중단) 허용 추가.
--
-- 배경: 2026 여름 최종 활동 회원 SoT 의 '시즌 중단' 66명을 season-scoped 로 표현하기 위함.
--   whole-person growth_status='suspended' 는 과거 시즌(봄)에 소급 오표시되므로 사용하지 않는다.
--   season_key 단위 'stopped' 로 2026-summer 에만 중단을 귀속한다(과거 무영향).
--
-- ⚠ 인라인 CHECK 는 Postgres 가 IN(...) → (status = ANY (ARRAY[...])) 로 정규화하므로
--   'IN' 문자열 매칭으로는 못 찾는다. 아래 DO 블록은 status 컬럼 CHECK 를 이름·표현 무관하게
--   찾고, 이미 stopped 를 허용하면 skip, success/rest 만 허용하면 DROP 후 재생성한다(idempotent).
--
-- 적용: Supabase SQL Editor 에서 수동 실행(프로젝트 컨벤션).
-- 의존: 2026-05-25_season_definitions_and_user_seasons.sql

-- ── (참고) 기존 constraint 이름/정의 조회 — 먼저 실행해 확인 가능 ──
-- SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--  WHERE conrelid = 'public.user_season_statuses'::regclass AND contype = 'c';
-- 예상 결과: user_season_statuses_status_check |
--           CHECK ((status = ANY (ARRAY['success'::text, 'rest'::text])))

DO $$
DECLARE
  cn   text;
  cdef text;
BEGIN
  -- status 컬럼에 걸린 CHECK 제약(이름 무관, 정규화 표현 무관) 탐색.
  SELECT conname, pg_get_constraintdef(oid)
    INTO cn, cdef
    FROM pg_constraint
   WHERE conrelid = 'public.user_season_statuses'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%'
   ORDER BY conname
   LIMIT 1;

  IF cn IS NULL THEN
    -- CHECK 없음 → 신규 추가.
    ALTER TABLE public.user_season_statuses
      ADD CONSTRAINT user_season_statuses_status_check
      CHECK (status IN ('success', 'rest', 'stopped'));
    RAISE NOTICE 'added user_season_statuses_status_check (success/rest/stopped)';

  ELSIF cdef ILIKE '%stopped%' THEN
    -- 이미 stopped 허용 → 변경 없음(재실행 안전).
    RAISE NOTICE 'skip: % already allows stopped -> %', cn, cdef;

  ELSE
    -- success/rest 만 허용 → 기존 제약 제거 후 stopped 포함 재생성.
    --   (기존 데이터는 전부 success/rest 이므로 새 CHECK 위반 없음.)
    EXECUTE format('ALTER TABLE public.user_season_statuses DROP CONSTRAINT %I', cn);
    ALTER TABLE public.user_season_statuses
      ADD CONSTRAINT user_season_statuses_status_check
      CHECK (status IN ('success', 'rest', 'stopped'));
    RAISE NOTICE 'recreated % to allow stopped (was: %)', cn, cdef;
  END IF;
END $$;

-- 적용 확인:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.user_season_statuses'::regclass AND contype='c';
-- SELECT status, count(*) FROM public.user_season_statuses GROUP BY status;  -- 기존 success/rest 보존 확인
