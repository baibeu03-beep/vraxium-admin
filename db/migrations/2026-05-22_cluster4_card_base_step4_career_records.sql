-- 2026-05-22_cluster4_card_base_step4_career_records.sql
-- Cluster4-card Work Career 의 user 별 기록(career_records) canonical 테이블 생성.
-- (UNIQUE(user_id, week_id, project_id) 를 처음부터 포함.)
--
-- 배경:
--   Cluster4-card Work Career 모달의 grade / enhancement_status / career_code 저장
--   대상 테이블이 어느 repo 의 schema 에도 정의되지 않아 운영 DB 미생성 상태였다.
--   따라서 `db/migrations/2026-05-21_career_records_unique_user_week_project__HOLD.sql`
--   의 UNIQUE 제약도 base 부재로 적용 실패. 본 migration 이 canonical base 를 도입하고
--   UNIQUE 도 한 번에 적용한다.
--
-- 정합성:
--   - `lib/careerRecordsTypes.ts` canonical 컬럼 문서 §career_records
--   - `lib/careerRecordsData.ts` RECORD_SELECT:
--       id, user_id, week_id, project_id, enhancement_status, grade,
--       grade_points, career_code, created_at
--   - upsert scope = (user_id, week_id, project_id) — UNIQUE 로 보장
--   - enhancement_status ∈ {'not_applicable','pending','enhanced','failed'} or NULL
--   - grade ∈ {'S','A','B','C','D'} or NULL
--   - grade_points integer, >= 0 or NULL
--   - career_code text or NULL (코드측 ≤50 chars 강제, DB 레벨에서는 길이 제한 없음)
--
-- FK 정책:
--   - user_profiles(user_id)  ON DELETE CASCADE  — 사용자 탈퇴 시 기록 제거
--   - weeks(id)               ON DELETE RESTRICT — 주차 카드 정의 보존
--   - career_projects(id)     ON DELETE RESTRICT — 프로젝트 폐기 시 reference 보존
--     (career_projects 삭제 정책은 admin 측 별도 검토. 본 migration 은 보수적 RESTRICT.)
--
-- 의존성:
--   - step2 (career_projects) 이전 적용 필수.
--
-- 비범위:
--   - 기존 row backfill — 신규 테이블이므로 해당 없음
--   - 추후 user 신청 write 경로 (POST /api/career-records) — 별도 PR
--   - RLS — service_role 전용 write 정책 유지
--
-- 재실행 안전:
--   - CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

BEGIN;

CREATE TABLE IF NOT EXISTS public.career_records (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id             uuid         NOT NULL
                                   REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_id             uuid         NOT NULL
                                   REFERENCES public.weeks(id) ON DELETE RESTRICT,

  project_id          uuid         NOT NULL
                                   REFERENCES public.career_projects(id) ON DELETE RESTRICT,

  enhancement_status  text         NULL,
  grade               text         NULL,
  grade_points        integer      NULL,
  career_code         text         NULL,

  created_at          timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT career_records_enhancement_status_chk
    CHECK (enhancement_status IS NULL OR enhancement_status IN
      ('not_applicable','pending','enhanced','failed')),
  CONSTRAINT career_records_grade_chk
    CHECK (grade IS NULL OR grade IN ('S','A','B','C','D')),
  CONSTRAINT career_records_grade_points_chk
    CHECK (grade_points IS NULL OR grade_points >= 0),
  CONSTRAINT career_records_unique_user_week_project
    UNIQUE (user_id, week_id, project_id)
);

CREATE INDEX IF NOT EXISTS career_records_user_idx
  ON public.career_records (user_id);

CREATE INDEX IF NOT EXISTS career_records_user_week_idx
  ON public.career_records (user_id, week_id);

CREATE INDEX IF NOT EXISTS career_records_project_idx
  ON public.career_records (project_id);

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TABLE IF EXISTS public.career_records;
COMMIT;
*/
