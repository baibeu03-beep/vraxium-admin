-- 2026-06-18_irregular_crew_reaction_all_partial.sql
-- 통합 > 허브별 프로세스 > 프로세스 체크 · 비정규 액트 (/admin/processes/check/irregular).
--
-- 정책 (2026-06-18 — 비정규 액트 '액트 종류' 전환):
--   - process_irregular_acts.crew_reaction 의 의미를 "의무 수준"(필수/선택/선발/없음)에서
--     "적용 범위"(전원/부분)로 전환한다.
--       · 구 enum: required | optional | selection | none  (필수/선택/선발/없음)
--       · 신규    : all | partial                          (전원/부분)
--   - 매핑(레거시 → 신규): required → all(전원), 그 외(optional/selection/none) → partial(부분).
--   - 적용 범위(전원/부분)는 포인트 C(미이행 페널티)와 무관 — 포인트 C 게이트(구 '필수'만 허용)는 폐지.
--     point_a/b/c 는 그대로 보존(0~20). 본 마이그레이션은 point_* 를 건드리지 않는다.
--   - ⚠ user_weekly_points · 주차 성장 계산 · snapshot · checkGate · demoUserId 무접촉.
--
-- 이미 적용된 DB(2026-06-15 마이그레이션이 돌아간 환경) 용 전진 마이그레이션.
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

-- 1) 기존 CHECK 제약 제거(신규 값 UPDATE 가 막히지 않도록 먼저).
ALTER TABLE public.process_irregular_acts
  DROP CONSTRAINT IF EXISTS process_irregular_acts_crew_reaction_check;

-- 2) 레거시 값 → 신규 2종 매핑(필수=전원 / 그 외=부분). 이미 전환된 행(all/partial)은 무변경.
UPDATE public.process_irregular_acts
   SET crew_reaction = CASE WHEN crew_reaction = 'required' THEN 'all' ELSE 'partial' END
 WHERE crew_reaction IN ('required', 'optional', 'selection', 'none');

-- 3) 기본값 전환(none → all).
ALTER TABLE public.process_irregular_acts
  ALTER COLUMN crew_reaction SET DEFAULT 'all';

-- 4) 신규 CHECK 제약 부여(전원/부분 2종만 허용).
ALTER TABLE public.process_irregular_acts
  ADD CONSTRAINT process_irregular_acts_crew_reaction_check
  CHECK (crew_reaction IN ('all', 'partial'));

COMMENT ON COLUMN public.process_irregular_acts.crew_reaction IS
  '액트 종류 — 전원(all)=전체 대상 적용 / 부분(partial)=일부 대상 적용. 적용 범위 구분(포인트 C 와 무관). 2026-06-18 구 required/optional/selection/none 에서 전환.';

-- PostgREST 스키마 캐시 즉시 리로드.
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용) — 잔여 레거시 값이 0 이어야 한다.
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT crew_reaction, count(*)
FROM public.process_irregular_acts GROUP BY 1 ORDER BY 1;
-- 기대: all / partial 만 존재 (required/optional/selection/none = 0).
*/
