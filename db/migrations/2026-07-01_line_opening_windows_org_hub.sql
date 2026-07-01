-- 2026-07-01_line_opening_windows_org_hub.sql
-- line_opening_windows 확장 — 예외를 '조직 범위(organization_slug) + 라인 종류(hub)' 로 스코핑.
--
-- 기존: (week_id, activity_type_id) 만으로 예외를 걸어 전 조직·전 허브(정보/경험/역량)에 적용됐다.
-- 변경: organization_slug·hub 컬럼 추가 →
--   organization_slug NULL = 전체 조직 · 값 = 그 조직만(encre|oranke|phalanx)
--   hub               NULL = 전체 라인 종류 · 값 = 그 허브만(info|experience|competency)
--
-- 판정: 예외가 (queryOrg, queryHub) 에 적용됨 ⇔
--   (org IS NULL OR org = queryOrg) AND (hub IS NULL OR hub = queryHub).
--   activity_type_id 는 종전대로 info 세부 라인(NULL=허브 전체)로 유지(직교 축).
--
-- 기존 행(org=NULL, hub=NULL)은 그대로 '전체/전체' 예외로 동작(회귀 0).
-- Idempotent — 재실행 안전.

ALTER TABLE public.line_opening_windows
  ADD COLUMN IF NOT EXISTS organization_slug text NULL,
  ADD COLUMN IF NOT EXISTS hub text NULL;

COMMENT ON COLUMN public.line_opening_windows.organization_slug
  IS 'NULL = 전체 조직, 값 존재 = 해당 조직만(encre|oranke|phalanx).';
COMMENT ON COLUMN public.line_opening_windows.hub
  IS 'NULL = 전체 라인 종류, 값 존재 = info|experience|competency 중 하나.';

-- ── 중복 방지 재정의 — (week_id, org, hub, activity_type_id) 조합당 1행 ──
--   기존 부분 unique 2종을 org/hub 포함 표현식 unique 1종으로 대체(NULL→'' 접기).
DROP INDEX IF EXISTS line_opening_windows_week_activity_uniq;
DROP INDEX IF EXISTS line_opening_windows_week_all_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS line_opening_windows_scope_uniq
  ON public.line_opening_windows (
    week_id,
    COALESCE(organization_slug, ''),
    COALESCE(hub, ''),
    COALESCE(activity_type_id, '')
  );

-- 판정 경로 인덱스(활성 예외 조회).
CREATE INDEX IF NOT EXISTS line_opening_windows_scope_active_idx
  ON public.line_opening_windows (is_active, allow_opening, week_id);


-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'line_opening_windows'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'line_opening_windows';

SELECT week_id, organization_slug, hub, activity_type_id, is_active, allow_opening, count(*)
FROM public.line_opening_windows
GROUP BY 1,2,3,4,5,6;
*/
