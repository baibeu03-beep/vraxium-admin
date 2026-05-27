-- 2026-05-27_cluster4_lines_add_output_link_2.sql
-- cluster4_lines 테이블에 output_link_2 컬럼 추가.
--
-- 배경:
--   Output Asset 정책: Link + Image 합산 최소 1, 최대 2.
--   기존 output_link_1 단일 컬럼으로는 Link 2개 저장 불가.
--   output_link_2 를 추가하여 정책 충족.
--
-- 재실행 안전: ADD COLUMN IF NOT EXISTS

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS output_link_2 text NULL;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS output_link_2;
*/
