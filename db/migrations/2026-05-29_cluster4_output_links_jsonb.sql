-- 2026-05-29_cluster4_output_links_jsonb.sql
-- Cluster4 output link 구조를 URL-only → URL + label(설명) 구조로 이원화.
--
-- 배경:
--   기존: output_link_1~5 가 단순 text URL 만 저장. 링크 설명(label) 저장 불가.
--   변경: output_links jsonb 컬럼을 신설하여 [{ "url": ..., "label": ... }] 형태로
--         URL 과 설명을 함께 저장한다.
--
-- 대상 테이블 / 기존 컬럼:
--   - cluster4_lines                  : output_link_1, output_link_2
--   - cluster4_line_submissions       : output_link_2, output_link_3, output_link_4, output_link_5
--   - cluster4_experience_line_drafts : output_link_1, output_link_2
--
-- 정책:
--   1) 기존 output_link_1~5 컬럼은 삭제하지 않는다 (backward compatibility 유지).
--   2) 기존 값을 output_links 로 backfill 한다. label 은 기존 데이터에 없으므로 NULL.
--   3) URL 순서(1→2→3→4→5)를 보존한다.
--   4) NULL / 빈 문자열 URL 은 제외한다.
--
-- 형태:
--   [
--     { "url": "https://...", "label": "링크 설명" }   -- label 은 신규 입력분에만 존재
--   ]
--
-- 재실행 안전:
--   - ADD COLUMN IF NOT EXISTS
--   - backfill 은 output_links = '[]'::jsonb (아직 채워지지 않은 행) 만 대상으로 하여 멱등.

BEGIN;

-- ============================================================
-- 1) 컬럼 추가
-- ============================================================

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS output_links jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.cluster4_line_submissions
  ADD COLUMN IF NOT EXISTS output_links jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.cluster4_experience_line_drafts
  ADD COLUMN IF NOT EXISTS output_links jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.cluster4_lines.output_links IS
  'URL + label 구조 output link 배열. 형태: [{"url": text, "label": text|null}]. 레거시 output_link_1/2 와 병행 유지.';
COMMENT ON COLUMN public.cluster4_line_submissions.output_links IS
  'URL + label 구조 output link 배열. 형태: [{"url": text, "label": text|null}]. 레거시 output_link_2~5 와 병행 유지.';
COMMENT ON COLUMN public.cluster4_experience_line_drafts.output_links IS
  'URL + label 구조 output link 배열. 형태: [{"url": text, "label": text|null}]. 레거시 output_link_1/2 와 병행 유지.';

-- ============================================================
-- 2) 기존 output_link_* → output_links backfill
--    URL 순서 보존(ORDER BY ord), NULL/빈 문자열 제외, label = NULL.
--    이미 채워진 행(output_links <> '[]')은 건너뛴다(멱등).
-- ============================================================

UPDATE public.cluster4_lines AS t
SET output_links = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('url', btrim(s.url), 'label', NULL) ORDER BY s.ord),
    '[]'::jsonb
  )
  FROM (
    VALUES
      (1, t.output_link_1),
      (2, t.output_link_2)
  ) AS s(ord, url)
  WHERE s.url IS NOT NULL AND btrim(s.url) <> ''
)
WHERE t.output_links = '[]'::jsonb
  AND (
    (t.output_link_1 IS NOT NULL AND btrim(t.output_link_1) <> '')
    OR (t.output_link_2 IS NOT NULL AND btrim(t.output_link_2) <> '')
  );

UPDATE public.cluster4_line_submissions AS t
SET output_links = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('url', btrim(s.url), 'label', NULL) ORDER BY s.ord),
    '[]'::jsonb
  )
  FROM (
    VALUES
      (2, t.output_link_2),
      (3, t.output_link_3),
      (4, t.output_link_4),
      (5, t.output_link_5)
  ) AS s(ord, url)
  WHERE s.url IS NOT NULL AND btrim(s.url) <> ''
)
WHERE t.output_links = '[]'::jsonb
  AND (
    (t.output_link_2 IS NOT NULL AND btrim(t.output_link_2) <> '')
    OR (t.output_link_3 IS NOT NULL AND btrim(t.output_link_3) <> '')
    OR (t.output_link_4 IS NOT NULL AND btrim(t.output_link_4) <> '')
    OR (t.output_link_5 IS NOT NULL AND btrim(t.output_link_5) <> '')
  );

UPDATE public.cluster4_experience_line_drafts AS t
SET output_links = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('url', btrim(s.url), 'label', NULL) ORDER BY s.ord),
    '[]'::jsonb
  )
  FROM (
    VALUES
      (1, t.output_link_1),
      (2, t.output_link_2)
  ) AS s(ord, url)
  WHERE s.url IS NOT NULL AND btrim(s.url) <> ''
)
WHERE t.output_links = '[]'::jsonb
  AND (
    (t.output_link_1 IS NOT NULL AND btrim(t.output_link_1) <> '')
    OR (t.output_link_2 IS NOT NULL AND btrim(t.output_link_2) <> '')
  );

COMMIT;

-- ============================================================
-- 검증 쿼리 (수동 확인용 — 트랜잭션 외부)
-- ============================================================
/*
-- 백필된 행 수 / 샘플 확인
SELECT 'cluster4_lines' AS tbl,
       count(*) FILTER (WHERE output_links <> '[]'::jsonb) AS filled_rows,
       count(*) AS total_rows
FROM public.cluster4_lines
UNION ALL
SELECT 'cluster4_line_submissions',
       count(*) FILTER (WHERE output_links <> '[]'::jsonb),
       count(*)
FROM public.cluster4_line_submissions
UNION ALL
SELECT 'cluster4_experience_line_drafts',
       count(*) FILTER (WHERE output_links <> '[]'::jsonb),
       count(*)
FROM public.cluster4_experience_line_drafts;

-- 레거시 ↔ jsonb 정합성 샘플
SELECT id, output_link_1, output_link_2, output_links
FROM public.cluster4_lines
WHERE output_links <> '[]'::jsonb
LIMIT 10;
*/

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
ALTER TABLE public.cluster4_experience_line_drafts DROP COLUMN IF EXISTS output_links;
ALTER TABLE public.cluster4_line_submissions       DROP COLUMN IF EXISTS output_links;
ALTER TABLE public.cluster4_lines                  DROP COLUMN IF EXISTS output_links;
COMMIT;
*/
