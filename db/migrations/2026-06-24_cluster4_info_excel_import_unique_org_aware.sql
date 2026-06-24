-- ─────────────────────────────────────────────────────────────────────────
-- cluster4_info_excel_import_unique_idx 를 org 인지(line_code 포함)로 완화.
--
-- 문제: 기존 인덱스가 (activity_type_id, week_id, main_title) 로만 유니크 →
--   서로 다른 org 가 같은 주차에 동일 제목의 excel_import info 라인을 가질 수 없음.
--   phalanx 실무정보 import 시 외부 초청특강(트렌드 코리아 한다혜/이혜원·김난도 등)
--   3건이 기존 encre(EC) 라인과 제목이 동일 → insert 차단(중복키 위반).
--
-- 해결: line_code(=org 토큰 포함) 를 유니크 키에 추가. row 데이터는 변경 없음.
--   - common 라인(line_code IS NULL)은 COALESCE 로 '' 에 모여 기존 보호(act+week+title 1행) 유지.
--   - EC/OK/PX 등 org 토큰은 서로 구분 → 동일 제목 cross-org 공존 허용.
--
-- 가역적: 아래 ROLLBACK 으로 원복(단, 원복 시 cross-org 동일 제목 행이 있으면 실패할 수 있음).
-- 수동 적용(Supabase SQL Editor) — 코드/PostgREST 로 DDL 미실행.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS public.cluster4_info_excel_import_unique_idx;

CREATE UNIQUE INDEX cluster4_info_excel_import_unique_idx
  ON public.cluster4_lines (activity_type_id, week_id, main_title, COALESCE(line_code, ''))
  WHERE part_type = 'info'
    AND source_type = 'excel_import'
    AND activity_type_id IS NOT NULL
    AND week_id IS NOT NULL;

COMMIT;

/*
ROLLBACK reference:

BEGIN;
DROP INDEX IF EXISTS public.cluster4_info_excel_import_unique_idx;
CREATE UNIQUE INDEX cluster4_info_excel_import_unique_idx
  ON public.cluster4_lines (activity_type_id, week_id, main_title)
  WHERE part_type = 'info'
    AND source_type = 'excel_import'
    AND activity_type_id IS NOT NULL
    AND week_id IS NOT NULL;
COMMIT;
*/
