-- 2026-05-12_schools_source_unique.sql
-- public.schools 에 (source, source_id) 복합 UNIQUE 제약 추가.
-- scripts/sync-schools.ts 가 외부 소스(career.go.kr 등) 별로 idempotent upsert 하기 위해 필요.

CREATE UNIQUE INDEX IF NOT EXISTS schools_source_source_id_key
  ON public.schools (source, source_id);
