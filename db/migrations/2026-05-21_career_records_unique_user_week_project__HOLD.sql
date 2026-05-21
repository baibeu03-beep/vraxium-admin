-- 2026-05-21_career_records_unique_user_week_project__HOLD.sql
-- career_records (user_id, week_id, project_id) UNIQUE 제약 추가.
--
-- ⚠️ HOLD: 적용 전 반드시 아래 SQL 로 중복 row 존재 여부를 확인할 것.
--   SELECT user_id, week_id, project_id, COUNT(*) AS dup_count
--   FROM public.career_records
--   GROUP BY user_id, week_id, project_id
--   HAVING COUNT(*) > 1;
--
--   - 0 rows 결과 → 본 migration 안전하게 적용 가능.
--   - 1+ rows 결과 → cleanup PR 선행 필요 (id 최신 row 만 유지하고 나머지 삭제).
--
-- 배경:
--   Admin Cluster4 Work Career sub-tab 의 PATCH 는 (user_id, week_id, project_id)
--   scope 에서 grade / enhancement_status / career_code 를 upsert 한다. UNIQUE
--   제약이 없으면 동일 scope 의 row 가 의도치 않게 다중 생성될 수 있음.
--
-- 정책:
--   - 본 UNIQUE 제약은 Admin/Front 양쪽 write 경로 모두에 통일 적용.
--   - 향후 Phase 6 의 user 신청 write (POST /api/career-records) 도 동일 scope 으로 upsert.
--
-- 재실행 안전:
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.

BEGIN;

ALTER TABLE public.career_records
  DROP CONSTRAINT IF EXISTS career_records_unique_user_week_project;

ALTER TABLE public.career_records
  ADD CONSTRAINT career_records_unique_user_week_project
  UNIQUE (user_id, week_id, project_id);

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
ALTER TABLE public.career_records
  DROP CONSTRAINT IF EXISTS career_records_unique_user_week_project;
COMMIT;
*/
