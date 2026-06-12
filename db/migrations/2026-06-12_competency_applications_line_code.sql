-- 2026-06-12_competency_applications_line_code.sql
-- 실무 역량 신청 명단에 line_code 컬럼 추가(수동 추가 드롭다운 선택값 denormalize).
--
-- 배경:
--   수동 추가 시 라인명을 자유 입력하지 않고 competency master line 드롭다운으로 선택하도록 변경.
--   선택값(line_master_id=competency_line_master_id, line_name)에 더해 line_code 도 함께 저장한다
--   (오타 방지 + 목록 표시 + 개설 시 line_code 기준 cluster4_lines 생성 정합).
--   part_type 은 본 테이블이 competency 전용이므로 컬럼 없이 'competency' 로 암묵 고정.
--
-- Idempotent — 재실행 안전.

ALTER TABLE public.cluster4_competency_applications
  ADD COLUMN IF NOT EXISTS line_code text NULL;

COMMENT ON COLUMN public.cluster4_competency_applications.line_code
  IS '수동 추가 드롭다운에서 선택한 competency master line 의 line_code(denormalize). 고객 신청은 NULL 가능.';
