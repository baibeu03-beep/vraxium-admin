-- 2026-05-30_cluster4_line_submissions_common_fields.sql
-- Cluster4 4개 허브(info/experience/competency/career) 공통 사용자 제출 필드 정리.
--
-- 배경:
--   info_subtitle / info_growth_point 는 "운영자 라인 입력값"이 아니라 크루원(사용자)
--   제출값이다. 또한 4개 허브의 제출 필드 구조는 공통이므로 허브 prefix 컬럼을 만들지 않고
--   cluster4_line_submissions 에 공통 컬럼으로 보관한다.
--   - subtitle      : 이미 존재 (공통 재사용)
--   - output_links  : 이미 존재 (공통 재사용, jsonb)
--   - growth_point  : 신규 추가 (공통)
--   - output_images : 신규 추가 (공통, cluster4_lines 와 동일한 [{url,caption}] 형태)
--
-- 정책:
--   1) 허브 prefix 컬럼(info_growth_point 등)은 만들지 않는다.
--   2) NULL/DEFAULT 허용 → 기존 행/동작 무영향.
--   3) 기존 데이터 백필 없음.
--   4) cluster4_lines.info_subtitle / info_growth_point 는 이번 단계에서 DROP 하지 않고
--      deprecated 주석만 단다 (안정화 후 별도 마이그레이션에서 DROP).
--   5) status / enhancement_status 는 컬럼화하지 않는다 (read-time 계산 유지).
--
-- 의존: 2026-05-26_cluster4_line_opening_step1_tables.sql,
--       2026-05-29_cluster4_output_links_jsonb.sql 적용 후.
-- 재실행 안전(멱등): ADD COLUMN IF NOT EXISTS.

BEGIN;

-- ============================================================
-- 1) 공통 제출 컬럼 추가 (cluster4_line_submissions)
-- ============================================================

ALTER TABLE public.cluster4_line_submissions
  ADD COLUMN IF NOT EXISTS growth_point  text  NULL,
  ADD COLUMN IF NOT EXISTS output_images jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.cluster4_line_submissions.growth_point IS
  '크루원 제출 그로스 포인트. 4개 허브 공통 제출 필드. (구 cluster4_lines.info_growth_point 대체)';
COMMENT ON COLUMN public.cluster4_line_submissions.output_images IS
  '크루원 제출 이미지 배열. 형태: [{"url": text, "caption": text|null}]. cluster4_lines.output_images 와 동일 구조.';

COMMENT ON COLUMN public.cluster4_line_submissions.subtitle IS
  '크루원 제출 서브 타이틀. 4개 허브 공통 제출 필드. (구 cluster4_lines.info_subtitle 대체)';

-- ============================================================
-- 2) cluster4_lines.info_* deprecated 표기 (DROP 아님)
--    읽기·쓰기 경로는 코드에서 제거되며, 컬럼은 안정화 후 별도 마이그레이션에서 DROP.
-- ============================================================

COMMENT ON COLUMN public.cluster4_lines.info_subtitle IS
  'DEPRECATED (2026-05-30): 크루원 제출값으로 재정의됨 → cluster4_line_submissions.subtitle 사용. 읽기·쓰기 중단. 안정화 후 DROP 예정.';
COMMENT ON COLUMN public.cluster4_lines.info_growth_point IS
  'DEPRECATED (2026-05-30): 크루원 제출값으로 재정의됨 → cluster4_line_submissions.growth_point 사용. 읽기·쓰기 중단. 안정화 후 DROP 예정.';

COMMIT;

-- ============================================================
-- 검증 쿼리 (수동 확인용 — 트랜잭션 외부)
-- ============================================================
/*
-- 컬럼 추가 확인
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cluster4_line_submissions'
  AND column_name IN ('subtitle', 'growth_point', 'output_links', 'output_images')
ORDER BY column_name;

-- 기존 행 무영향 확인 (growth_point NULL, output_images '[]')
SELECT count(*) AS total,
       count(*) FILTER (WHERE growth_point IS NULL) AS growth_null,
       count(*) FILTER (WHERE output_images = '[]'::jsonb) AS images_empty
FROM public.cluster4_line_submissions;
*/

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
ALTER TABLE public.cluster4_line_submissions
  DROP COLUMN IF EXISTS output_images,
  DROP COLUMN IF EXISTS growth_point;
COMMIT;
*/
