-- 2026-07-31_process_irregular_acts_hub_line_grade.sql
-- 변동 액트(/admin/processes/check/irregular) — "소속 허브 급" · "소속 라인 급" 저장.
--
-- 정책:
--   - hub_grade : 변동 액트가 속한 허브 급. 프로세스 등록의 허브급 SoT(process_acts.hub 와 동일
--     4값 부분집합)를 그대로 쓴다 — club(클럽 총괄) | info(실무 정보) | experience(실무 경험) |
--     competency(실무 역량). career(실무 경력)는 변동 액트 대상이 아니다.
--   - line_grade: 변동 액트는 항상 "변동 액트" 1종 — 'variable_act' 로 고정. 사용자가 바꿀 수 없고
--     서버가 항상 이 값으로 강제한다(CHECK 로 DB 레벨까지 강제).
--   - 기존 행은 전부 hub_grade='club'(클럽 총괄) · line_grade='variable_act' 로 일괄 backfill한다
--     (액트명/조직으로 개별 허브 복원하지 않음 — 요구사항 §8 확정 정책).
--
-- 순서(안전): 1) nullable 컬럼 추가 → 2) 기존 행 backfill → 3) NULL 잔여 검증 →
--            4) NOT NULL + CHECK 적용 → 5) 조회 인덱스(신규 필터 조합) → 6) PostgREST 리로드.
--
-- Idempotent. Supabase SQL Editor 또는 scripts/run-sql-direct.ts 로 적용.

BEGIN;

-- 1) nullable 컬럼 추가.
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS hub_grade text NULL;
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS line_grade text NULL DEFAULT 'variable_act';

-- 2) 기존 행 일괄 backfill(요구사항 §8 — 개별 허브 복원 시도하지 않음).
DO $$
DECLARE
  v_before_null_hub bigint;
  v_before_null_line bigint;
  v_backfilled_hub bigint;
  v_backfilled_line bigint;
BEGIN
  SELECT count(*) INTO v_before_null_hub FROM public.process_irregular_acts WHERE hub_grade IS NULL;
  SELECT count(*) INTO v_before_null_line FROM public.process_irregular_acts WHERE line_grade IS NULL;
  RAISE NOTICE '[plan] hub_grade NULL 행: %, line_grade NULL 행: %', v_before_null_hub, v_before_null_line;

  UPDATE public.process_irregular_acts
  SET hub_grade = 'club'
  WHERE hub_grade IS NULL;
  GET DIAGNOSTICS v_backfilled_hub = ROW_COUNT;

  UPDATE public.process_irregular_acts
  SET line_grade = 'variable_act'
  WHERE line_grade IS NULL;
  GET DIAGNOSTICS v_backfilled_line = ROW_COUNT;

  RAISE NOTICE '[update] hub_grade backfill 행 수: % (club)', v_backfilled_hub;
  RAISE NOTICE '[update] line_grade backfill 행 수: % (variable_act)', v_backfilled_line;
END $$;

-- 3) NULL 잔여 검증 — 하나라도 남으면 마이그레이션을 중단한다(트랜잭션 전체 ROLLBACK).
DO $$
DECLARE
  v_null_hub bigint;
  v_null_line bigint;
BEGIN
  SELECT count(*) INTO v_null_hub FROM public.process_irregular_acts WHERE hub_grade IS NULL;
  SELECT count(*) INTO v_null_line FROM public.process_irregular_acts WHERE line_grade IS NULL;
  RAISE NOTICE '[verify] backfill 후 hub_grade NULL 잔여: %, line_grade NULL 잔여: %', v_null_hub, v_null_line;
  IF v_null_hub > 0 OR v_null_line > 0 THEN
    RAISE EXCEPTION 'backfill 후에도 NULL 이 남아있습니다(hub_grade=%, line_grade=%) — NOT NULL 적용 중단', v_null_hub, v_null_line;
  END IF;
END $$;

-- 4) NOT NULL + CHECK 적용(멱등 — 이미 걸려있으면 스킵).
ALTER TABLE public.process_irregular_acts
  ALTER COLUMN hub_grade SET NOT NULL;
ALTER TABLE public.process_irregular_acts
  ALTER COLUMN line_grade SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'process_irregular_acts_hub_grade_check'
  ) THEN
    ALTER TABLE public.process_irregular_acts
      ADD CONSTRAINT process_irregular_acts_hub_grade_check
      CHECK (hub_grade IN ('club', 'info', 'experience', 'competency'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'process_irregular_acts_line_grade_check'
  ) THEN
    ALTER TABLE public.process_irregular_acts
      ADD CONSTRAINT process_irregular_acts_line_grade_check
      CHECK (line_grade = 'variable_act');
  END IF;
END $$;

-- 5) 조회 인덱스 — 보드/주차 매칭 필터(organization_slug, week_id, scope_mode, hub_grade) 그대로 반영.
--    기존 idx_process_irregular_acts_scope(org,week,created_at)는 남겨둔다(정렬용 유지).
CREATE INDEX IF NOT EXISTS idx_process_irregular_acts_hub_grade
  ON public.process_irregular_acts (organization_slug, week_id, scope_mode, hub_grade);

COMMENT ON COLUMN public.process_irregular_acts.hub_grade IS
  '소속 허브 급 — club(클럽 총괄)|info(실무 정보)|experience(실무 경험)|competency(실무 역량). 프로세스 등록 허브급 SoT(ProcessHub) 재사용. 신규 행은 관리자가 4종 중 선택(필수), 기존 행은 전부 club 으로 backfill.';
COMMENT ON COLUMN public.process_irregular_acts.line_grade IS
  '소속 라인 급 — 변동 액트는 항상 ''variable_act'' 1종 고정(사용자 변경 불가, 서버 강제, DB CHECK 로도 강제).';

-- 6) PostgREST 스키마 캐시 즉시 리로드.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용 — 적용 후 아래를 SELECT 해 실제 분포 확인 가능)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT hub_grade, line_grade, count(*) FROM public.process_irregular_acts GROUP BY 1,2 ORDER BY 1,2;
SELECT count(*) FILTER (WHERE hub_grade IS NULL) AS hub_null,
       count(*) FILTER (WHERE line_grade IS NULL) AS line_null
FROM public.process_irregular_acts;
*/
