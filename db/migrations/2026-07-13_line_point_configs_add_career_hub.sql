-- ============================================================================
-- 실무 경력(career) 강화 포인트 설정 편입 — cluster4_line_point_configs.hub 에 'career' 추가.
--
--   기존: hub in ('info','experience','competency')  (2026-07-11_DRAFT_cluster4_line_point_configs.sql:22)
--   추가: 'career' — career 라인도 공통 라인 포인트 설정/지급 대상.
--         config_key 규약: career → cluster4_lines.line_code (역량과 동일 라인별 단위).
--
--   point_a / point_b 는 기존과 동일하게 독립 nullable(null=미지급, 0 포함 숫자=지급 대상).
--   ⚠ 수동 적용(SQL Editor). 미적용 시 career 포인트 upsert 는 503(테이블/제약 미적용)로 안전 실패.
-- ============================================================================

ALTER TABLE public.cluster4_line_point_configs
  DROP CONSTRAINT IF EXISTS cluster4_line_point_configs_hub_check;

ALTER TABLE public.cluster4_line_point_configs
  ADD CONSTRAINT cluster4_line_point_configs_hub_check
  CHECK (hub IN ('info', 'experience', 'competency', 'career'));
