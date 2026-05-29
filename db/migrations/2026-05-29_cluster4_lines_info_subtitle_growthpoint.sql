-- 2026-05-29_cluster4_lines_info_subtitle_growthpoint.sql
-- 실무 정보(part_type='info') 라인 개설 시 운영자가 입력하는
-- "서브 타이틀"·"그로스 포인트" 저장용 컬럼 2개를 cluster4_lines 에 추가.
--
-- 배경:
--   기존 cluster4_lines 에는 main_title 만 있었고 서브 타이틀/그로스 포인트 컬럼이 없었다.
--   서브 타이틀 컬럼은 cluster4_line_submissions.subtitle 로 이미 존재하나, 그것은
--   "크루원 2차 제출" 필드이며 운영자 라인 개설 입력과는 별개의 축이다.
--   혼동을 막기 위해 운영자 입력값은 info_subtitle / info_growth_point 로 명시 분리한다.
--
-- 정책 / backward compatibility:
--   1) NULL 허용 text 2개 추가 (기존 행/입력 영향 없음).
--   2) info 외 part_type(experience/competency/career) 라인은 NULL 로 둔다.
--   3) cluster4_line_submissions.subtitle 설계는 변경하지 않는다.
--
-- 재실행 안전(멱등): ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS info_subtitle      text NULL,
  ADD COLUMN IF NOT EXISTS info_growth_point  text NULL;

COMMENT ON COLUMN public.cluster4_lines.info_subtitle IS
  '운영자 라인 개설 시 입력하는 서브 타이틀(실무 정보 전용). 크루원 제출 cluster4_line_submissions.subtitle 과 별개 축.';
COMMENT ON COLUMN public.cluster4_lines.info_growth_point IS
  '운영자 라인 개설 시 입력하는 그로스 포인트(실무 정보 전용).';

COMMIT;

-- ============================================================
-- 검증 쿼리 (수동 확인용 — 트랜잭션 외부)
-- ============================================================
/*
SELECT id, main_title, info_subtitle, info_growth_point
FROM public.cluster4_lines
WHERE part_type = 'info'
ORDER BY created_at DESC
LIMIT 10;
*/

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS info_growth_point,
  DROP COLUMN IF EXISTS info_subtitle;
COMMIT;
*/
