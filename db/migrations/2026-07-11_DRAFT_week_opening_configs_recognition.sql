-- ============================================================================
-- DRAFT · Phase 3 · 미적용(NOT APPLIED)
--   주차별 활동 인정 개수 N 저장(안2: A·B·N + calc_version).
--   오픈확인(cluster4_week_opening_configs) row 와 동일 생명주기 — undo 시 함께 무효.
--   SQL Editor 수동 적용 전까지 스키마 미반영.
--
--   저장 위치 근거(3안 비교 중 채택):
--    - 안1(N만): 재현/감사 불가(A·B 근거 유실) → 기각.
--    - 안2(A·B·N + version): 오픈확인 시점 확정값 재현 가능 → 채택.
--    - 안3(계산 snapshot jsonb): 과설계. 필요 시 config jsonb 의 recognitionCalc 키로 흡수.
-- ============================================================================

ALTER TABLE public.cluster4_week_opening_configs
  ADD COLUMN IF NOT EXISTS min_points_a integer,        -- A(최소자) 총합
  ADD COLUMN IF NOT EXISTS exec_points_b integer,       -- B(성실자) 총합
  ADD COLUMN IF NOT EXISTS recognition_count_n integer, -- N = round(A + 0.4×(B−A))
  ADD COLUMN IF NOT EXISTS recognition_calc_version smallint;

COMMENT ON COLUMN public.cluster4_week_opening_configs.min_points_a IS
  'A(최소자): 필수 액트 + [실무경험] 오픈라인 최소이행 시 (Point.A+Point.B) 총합. 오픈확인 시점 확정.';
COMMENT ON COLUMN public.cluster4_week_opening_configs.exec_points_b IS
  'B(성실자): 모든 가동 액트(basic 제외) + 모든 오픈라인 이행 시 (Point.A+Point.B) 총합.';
COMMENT ON COLUMN public.cluster4_week_opening_configs.recognition_count_n IS
  '주차별 활동 인정 개수 N = round(A + 0.4×(B−A)). 활동관리 화면·/week-recognitions 공용 조회값.';
COMMENT ON COLUMN public.cluster4_week_opening_configs.recognition_calc_version IS
  '산식 버전(lib/weekRecognitionCount RECOGNITION_CALC_VERSION). 산식 변경 추적/재현용.';
