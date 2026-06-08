-- 2026-06-07_line_registrations_unit_link.sql
-- 라인 등록 "유닛 링크" 요구사항 정정 (additive append).
--
-- 정정 (2026-06-07): 유닛 링크는 output link/image 구조가 아니라 **단일 텍스트 필드**.
--   - URL 형식 강제 없음(일반 텍스트 허용), 미입력 시 '-' 저장.
--   - 신규 저장/조회는 unit_link 만 사용한다.
--   - output_links / output_images 컬럼은 삭제하지 않고 deprecated 로 보존
--     (초기 등록분 4건의 기존 값도 그대로 보존 — 읽기/쓰기 모두 중단만).
--
-- 기존 행 처리: ADD COLUMN ... NOT NULL DEFAULT '-' 는 기존 행을 '-' 로 안전하게 채운다.
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS unit_link text NOT NULL DEFAULT '-';

COMMENT ON COLUMN public.line_registrations.unit_link IS
  '유닛 링크 — 단일 텍스트(URL 형식 강제 없음). 미입력 시 ''-''. 2026-06-07 정정으로 output_links/output_images 를 대체.';
COMMENT ON COLUMN public.line_registrations.output_links IS
  'DEPRECATED (2026-06-07) — unit_link 로 대체. 신규 저장/조회 미사용, 컬럼·기존 값 보존만.';
COMMENT ON COLUMN public.line_registrations.output_images IS
  'DEPRECATED (2026-06-07) — unit_link 로 대체. 신규 저장/조회 미사용, 컬럼·기존 값 보존만.';
