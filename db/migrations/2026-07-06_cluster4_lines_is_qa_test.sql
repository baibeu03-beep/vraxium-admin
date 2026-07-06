-- Cluster4 라인 QA 테스트 표식(is_qa_test) 컬럼.
--
-- 목적:
--   - QA 기간(lib/qaFixedScope.ts QA_HIDE_REAL_USERS=true)에 앱에서 생성되는 라인을 "QA 전용"으로 표식한다.
--   - 운영 조회(QA_HIDE_REAL_USERS=false)에서는 이 라인을 강화율/카드 렌더에서 제외한다
--     (fetchAllLineTargetsByWeek / fetchActiveInfoLinesByWeek 필터). QA 조회에서는 운영+QA 모두 노출.
--   - QA 종료 시 scripts/qa-end-hide-qa-lines.ts 로 is_active=false(가역) 또는 --purge(삭제)한다.
--
-- 기본값 false → 이 마이그레이션 이전 전 라인은 운영 라인으로 남는다(무회귀).
-- 각인: 모든 앱 driven cluster4_lines insert 지점이 is_qa_test: QA_HIDE_REAL_USERS 로 기록(생성 시점 스코프).
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 멱등(IF NOT EXISTS). 코드 배포 전 실행 권장
--   (배포된 필터가 컬럼을 참조하므로 컬럼이 먼저 있어야 안전 — 컬럼 부재 시 필터 쿼리 42703).

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS is_qa_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cluster4_lines.is_qa_test IS
  'QA 전용 라인 표식(생성 시 QA_HIDE_REAL_USERS 각인). true=QA 기간 생성분 — 운영 조회에서 제외, QA 종료 시 정리. 기본 false=운영 라인.';

-- QA 라인만 좁게 스캔(정리 스크립트/QA-only 조회)용 부분 인덱스.
-- 운영 라인(false)이 다수라 false 쪽은 선택도가 낮아 인덱싱하지 않는다.
CREATE INDEX IF NOT EXISTS cluster4_lines_is_qa_test_true_idx
  ON public.cluster4_lines (is_qa_test)
  WHERE is_qa_test = true;

COMMIT;

-- rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS public.cluster4_lines_is_qa_test_true_idx;
-- ALTER TABLE public.cluster4_lines DROP COLUMN IF EXISTS is_qa_test;
-- COMMIT;
