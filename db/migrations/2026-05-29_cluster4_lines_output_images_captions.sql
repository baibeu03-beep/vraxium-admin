-- 2026-05-29_cluster4_lines_output_images_captions.sql
-- Cluster4 라인 output 이미지에 캡션(caption)을 함께 저장하도록 구조 확장.
--
-- 배경:
--   기존: cluster4_lines.output_images = jsonb 배열 (URL 문자열만). 예: ["https://a", "https://b"]
--   변경: 각 원소를 { "url": ..., "caption": ... } 객체로 저장. 예:
--         [{ "url": "https://a", "caption": "도면 1" }, { "url": "https://b", "caption": null }]
--
-- 권장안 채택: A안 (jsonb 원소에 caption 필드 추가).
--   - output_images 가 이미 jsonb 이므로 새 컬럼 추가 없이 원소 형태만 확장 → 충돌 최소.
--   - output_links(URL+label) 선례와 동일한 패턴.
--
-- 정책 / backward compatibility:
--   1) 컬럼 추가/삭제 없음 (output_images jsonb 그대로 사용).
--   2) 기존 string 원소를 { "url": <string>, "caption": null } 객체로 backfill.
--   3) 빈 문자열 URL 원소는 제거. URL 순서 보존.
--   4) 읽기 코드(lib/cluster4OutputImages.ts)는 string · {url,caption} 두 형태를 모두 정규화하므로
--      이 마이그레이션을 적용하지 않아도 동작한다 (마이그레이션은 데이터 일관성 정리용).
--
-- 재실행 안전(멱등):
--   - 이미 객체로 변환된 행은 string 원소가 없으므로 EXISTS 가드에 의해 건너뛴다.

BEGIN;

COMMENT ON COLUMN public.cluster4_lines.output_images IS
  '운영자 첨부 이미지 배열. 형태: [{"url": text, "caption": text|null}]. 레거시 string[] 도 읽기 호환.';

-- 기존 string[] 원소 → {url, caption:null} 객체로 변환. 빈 URL 제거, 순서 보존.
UPDATE public.cluster4_lines AS t
SET output_images = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(e.elem) = 'string'
          THEN jsonb_build_object('url', btrim(e.elem #>> '{}'), 'caption', NULL)
        ELSE e.elem
      END
      ORDER BY e.ord
    )
    FROM jsonb_array_elements(t.output_images) WITH ORDINALITY AS e(elem, ord)
    WHERE NOT (
      jsonb_typeof(e.elem) = 'string' AND btrim(e.elem #>> '{}') = ''
    )
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(t.output_images) = 'array'
  AND t.output_images <> '[]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(t.output_images) AS x(elem)
    WHERE jsonb_typeof(x.elem) = 'string'
  );

COMMIT;

-- ============================================================
-- 검증 쿼리 (수동 확인용 — 트랜잭션 외부)
-- ============================================================
/*
-- caption 키를 가진 객체 원소 수 / 샘플
SELECT id, output_images
FROM public.cluster4_lines
WHERE output_images <> '[]'::jsonb
LIMIT 10;

-- 아직 string 원소가 남은 행 (0이어야 정상)
SELECT count(*)
FROM public.cluster4_lines
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(output_images) AS x(elem)
  WHERE jsonb_typeof(x.elem) = 'string'
);
*/

-- ============================================================
-- ROLLBACK (필요 시) — 객체 원소를 다시 url 문자열만으로 환원
-- ============================================================
/*
BEGIN;
UPDATE public.cluster4_lines AS t
SET output_images = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(e.elem) = 'object' THEN to_jsonb(e.elem ->> 'url')
        ELSE e.elem
      END
      ORDER BY e.ord
    )
    FROM jsonb_array_elements(t.output_images) WITH ORDINALITY AS e(elem, ord)
    WHERE NOT (jsonb_typeof(e.elem) = 'object' AND COALESCE(btrim(e.elem ->> 'url'), '') = '')
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(t.output_images) = 'array' AND t.output_images <> '[]'::jsonb;
COMMIT;
*/
