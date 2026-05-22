-- 2026-05-22_cluster4_card_base_step2_career_projects.sql
-- Cluster4-card Work Career 마스터(career_projects) canonical 테이블 생성.
--
-- 배경:
--   career_records 가 참조하는 master 테이블 career_projects 가 어느 repo 의 schema
--   에도 정의되지 않아 운영 DB 에 미생성 상태였다. 본 migration 으로 canonical base 를 도입한다.
--
-- 정합성:
--   - `lib/careerRecordsTypes.ts` canonical 컬럼 문서 §career_projects
--   - `lib/careerRecordsData.ts` PROJECT_SELECT (admin read 컬럼):
--       id, company_name, company_logo_url, job_position, project_name,
--       project_description, line_code, line_name, supervisor_name,
--       supervisor_position, supervisor_department, supervisor_company,
--       supervisor_profile_img
--   - 추가 컬럼(output_links, output_images, company_homepage_links,
--     secondary_info_deadline) 은 type 주석 기준 canonical 에 포함.
--     admin 은 본 컬럼들을 write 하지 않으나, Career-Resume Front 의 secondary info
--     화면 read 호환을 위해 처음부터 정의한다 (nullable / 빈 jsonb default).
--
-- FK 정책:
--   - 없음 (마스터 테이블)
--
-- 비범위:
--   - seed 데이터 — admin UI 또는 별도 seed migration 으로 분리
--   - RLS — 본 migration 그룹 컨벤션 (service_role 전용 write)
--
-- 재실행 안전:
--   - CREATE TABLE IF NOT EXISTS

BEGIN;

CREATE TABLE IF NOT EXISTS public.career_projects (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 회사 / 직무 메타
  company_name             text         NULL,
  company_logo_url         text         NULL,
  job_position             text         NULL,

  -- 프로젝트 메타
  project_name             text         NULL,
  project_description      text         NULL,
  line_code                text         NULL,
  line_name                text         NULL,

  -- Career-Resume Front secondary info (admin 미사용)
  output_links             jsonb        NOT NULL DEFAULT '[]'::jsonb,
  output_images            jsonb        NOT NULL DEFAULT '[]'::jsonb,
  company_homepage_links   jsonb        NOT NULL DEFAULT '[]'::jsonb,
  secondary_info_deadline  timestamptz  NULL,

  -- supervisor 정보 (admin 정의)
  supervisor_name          text         NULL,
  supervisor_position      text         NULL,
  supervisor_department    text         NULL,
  supervisor_company       text         NULL,
  supervisor_profile_img   text         NULL,

  created_at               timestamptz  NOT NULL DEFAULT now()
);

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TABLE IF EXISTS public.career_projects;
COMMIT;
*/
