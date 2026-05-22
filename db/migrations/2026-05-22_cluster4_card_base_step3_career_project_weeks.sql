-- 2026-05-22_cluster4_card_base_step3_career_project_weeks.sql
-- Cluster4-card Work Career 의 프로젝트×주차 junction 테이블 생성.
--
-- 배경:
--   특정 프로젝트가 특정 주차 활동으로 열려있는지(is_active)를 표현하는 junction.
--   user 신청 / Front secondary info 페이지에서 주차별 선택 가능 프로젝트 목록을 만드는 데 사용된다.
--   schema 가 어느 repo 에도 정의되지 않아 운영 DB 미생성 상태였다.
--
-- 정합성:
--   - `lib/careerRecordsTypes.ts` 주석 §career_project_weeks
--   - PK 는 (project_id, week_id) 복합 — 같은 (project, week) 중복 허용 안 함
--
-- FK 정책:
--   - career_projects(id)  ON DELETE CASCADE — 프로젝트 폐기 시 junction 자동 제거
--   - weeks(id)            ON DELETE RESTRICT — 주차 카드 정의는 강제 보존
--
-- 의존성:
--   - step2 (career_projects) 이전 적용 필수.
--
-- 비범위:
--   - seed — admin UI 또는 별도 seed migration 으로 분리
--   - is_active 기반 partial index — 사용 패턴 확정 후 후속 PR
--
-- 재실행 안전:
--   - CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

BEGIN;

CREATE TABLE IF NOT EXISTS public.career_project_weeks (
  project_id  uuid         NOT NULL
                           REFERENCES public.career_projects(id) ON DELETE CASCADE,

  week_id     uuid         NOT NULL
                           REFERENCES public.weeks(id) ON DELETE RESTRICT,

  is_active   boolean      NOT NULL DEFAULT true,

  created_at  timestamptz  NOT NULL DEFAULT now(),

  PRIMARY KEY (project_id, week_id)
);

CREATE INDEX IF NOT EXISTS career_project_weeks_week_idx
  ON public.career_project_weeks (week_id);

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TABLE IF EXISTS public.career_project_weeks;
COMMIT;
*/
