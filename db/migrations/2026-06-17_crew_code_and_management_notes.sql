-- 2026-06-17_crew_code_and_management_notes.sql
-- 크루 상세 페이지: (1) 확정 공식 크루 코드 + (2) 클럽 관리 기록(관리자 메모).
--
-- 배경:
--   · 크루 코드 = 운영 식별자. 공식:
--       (년생2)(성별1)(이름순3)-(클럽1)(YY2 시즌1 WW2)(성적1)   예) 036011-1263022
--     기존 user_profiles.crew_no(일련번호 1042류)와는 별개 — 재사용하지 않는다.
--   · 최초 1회 생성 후 고정(freeze). 일회성 공식 전환은 generate-crew-codes --force 로만.
--     교체 전 old/new 를 crew_code_log 에 남긴다(백업/감사).
--   · application_grade = 향후 면접관 평가값 저장 컬럼(현재 미입력). 생성 시
--     2026 여름 이전/기존 활동자는 전부 3, 이후 입회자는 application_grade ?? 3.
--   · 관리자 메모는 운영 기록이므로 user_profiles 에 넣지 않고 전용 테이블로 분리.
--
-- 수동 적용: Supabase SQL Editor 에서 1회 실행([[project_manual-migrations]]).
--   미적용 시 /api/admin/members/[userId] 가 컬럼 부재로 실패한다.
-- Idempotent — 재실행 안전.

-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: user_profiles — crew_code / 생성시각 / application_grade
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS crew_code text,
  ADD COLUMN IF NOT EXISTS crew_code_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS application_grade smallint;

-- 지원 평가 성적 1~5 범위 가드 (NULL 허용 = 미입력).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_profiles_application_grade_range'
      AND conrelid = 'public.user_profiles'::regclass
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_application_grade_range
      CHECK (application_grade IS NULL OR (application_grade BETWEEN 1 AND 5));
  END IF;
END;
$$;

-- 크루 코드 중복 금지(생성된 코드끼리만 — NULL 다수 허용).
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_crew_code_key
  ON public.user_profiles (crew_code)
  WHERE crew_code IS NOT NULL;

COMMENT ON COLUMN public.user_profiles.crew_code IS
  '운영 식별자(고정). 공식 (년생)(성별)(이름순)-(클럽)(시작주차)(지원성적). crew_no 와 별개.';
COMMENT ON COLUMN public.user_profiles.application_grade IS
  '지원 평가 성적 1~5(면접관 입력 예정). 미입력 NULL → 코드 생성 시 3 으로 처리.';

-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: crew_code_log — 코드 (재)생성 백업/감사 로그
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.crew_code_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  old_code        text,
  new_code        text,
  formula_version smallint NOT NULL DEFAULT 1,
  reason          text,            -- NULL 사유(미생성) 또는 'replace'/'create' 등
  generated_by    uuid,            -- 실행 admin (스크립트=NULL)
  generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crew_code_log_user_id_idx
  ON public.crew_code_log (user_id, generated_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: crew_management_notes — 클럽 관리 기록(관리자 메모, 사용자당 1행 upsert)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.crew_management_notes (
  user_id    uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  note       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 검증 (DML 아님 — 주석)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='user_profiles'
  AND column_name IN ('crew_code','crew_code_generated_at','application_grade');

SELECT to_regclass('public.crew_code_log'), to_regclass('public.crew_management_notes');

-- 중복 코드 0 확인
SELECT crew_code, COUNT(*) FROM public.user_profiles
WHERE crew_code IS NOT NULL GROUP BY crew_code HAVING COUNT(*) > 1;
*/
