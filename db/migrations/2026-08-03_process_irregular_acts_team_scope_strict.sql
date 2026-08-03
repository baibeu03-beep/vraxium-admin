-- 2026-08-03_process_irregular_acts_team_scope_strict.sql
-- process_irregular_acts 팀 스코프 CHECK 강화 — experience 행의 "팀 미지정" 유예를 제거한다.
--
-- 배경: 2026-08-03_process_irregular_acts_team_scope.sql 적용 시점엔 team 정보를 복원 못한 과거
--   experience 행이 있을 가능성을 대비해 "experience + 3컬럼 모두 NULL"도 허용하는 유예 CHECK를 걸었다.
--   지금은 hub_grade='experience' 행이 0건이라(과거 미배정 행 없음) 이 유예를 제거하고 최종 정책으로
--   확정한다: experience는 항상 team_id/team_name NOT NULL + part_scope='team_overall'만 허용.
--
-- 적용 전 자동 가드: experience 행 중 team_id가 NULL인 행이 하나라도 있으면 즉시 예외를 던져
--   전체 트랜잭션을 ROLLBACK한다(강화 제약을 걸었다가 기존 데이터가 위반하는 사고 방지).
--
-- Idempotent. Supabase SQL Editor 에서 수동 적용.

BEGIN;

DO $$
DECLARE
  v_unassigned bigint;
BEGIN
  SELECT count(*) INTO v_unassigned
  FROM public.process_irregular_acts
  WHERE hub_grade = 'experience' AND (team_id IS NULL OR team_name IS NULL OR part_scope IS DISTINCT FROM 'team_overall');
  RAISE NOTICE '[verify] 강화 전 위반 행(experience 인데 팀 미지정/이형): %', v_unassigned;
  IF v_unassigned > 0 THEN
    RAISE EXCEPTION '강화 제약을 위반하는 experience 행이 %건 있습니다 — 먼저 backfill 하거나 처리 후 재실행하세요.', v_unassigned;
  END IF;
END $$;

ALTER TABLE public.process_irregular_acts
  DROP CONSTRAINT IF EXISTS process_irregular_acts_team_scope_check;

ALTER TABLE public.process_irregular_acts
  ADD CONSTRAINT process_irregular_acts_team_scope_check
  CHECK (
    (
      hub_grade = 'experience'
      AND team_id IS NOT NULL
      AND team_name IS NOT NULL
      AND part_scope = 'team_overall'
    )
    OR
    (
      hub_grade <> 'experience'
      AND team_id IS NULL
      AND team_name IS NULL
      AND part_scope IS NULL
    )
  );

COMMENT ON CONSTRAINT process_irregular_acts_team_scope_check ON public.process_irregular_acts IS
  '최종 정책(2026-08-03 강화) — experience는 team_id/team_name NOT NULL + part_scope=team_overall 필수, 그 외 허브는 셋 다 NULL 필수. 유예(양쪽 NULL 허용) 제거됨.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT hub_grade, count(*) FILTER (WHERE team_id IS NULL) AS team_id_null,
       count(*) FILTER (WHERE team_name IS NULL) AS team_name_null,
       count(*) FILTER (WHERE part_scope IS DISTINCT FROM 'team_overall' AND hub_grade='experience') AS part_scope_bad
FROM public.process_irregular_acts GROUP BY hub_grade;
*/
