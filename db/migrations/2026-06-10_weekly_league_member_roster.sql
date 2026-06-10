-- 2026-06-10_weekly_league_member_roster.sql
-- weekly-league(/api/weekly-league · /weekly-ranking) 회원명부(PMS printUsers) 정합.
--
-- 목적(claudedocs/weekly-league-encre-member-roster-design-20260610.md):
--   현행 totalCrews=활동행(user_week_statuses 존재) 기준 → PMS 회원명부 기준으로 정합.
--   휴식 = restdates(개인) + weeks.is_official_rest(공식). user_week_statuses 무수정(개인카드/growth/resume/snapshot 무영향).
--
-- 데이터-게이트: weekly_league_roster_orgs 에 등록된 org 만 회원명부+restdates 경로 적용.
--   미등록 org(oranke/phalanx)는 현행 활동행+uws.status 경로 그대로(byte-identical) → 숫자 0 변화.
--
-- 본 마이그레이션은 3개 신규 테이블만 생성한다(기존 테이블 무변경). 데이터 적재는 별도 ingest 스크립트.
--   - crew_personal_rest_periods : restdates(개인휴식 기간) 격리 보존. weekly-league 만 소비.
--   - operator_markers           : PMS State='운영진' 표식. weekly-league 회원명부 필터에서 제외. test_user_markers 와 분리.
--   - weekly_league_roster_orgs  : 회원명부 모드 게이트(org allowlist).

-- ── 1) 개인휴식 기간 (restdates 격리본) ──
CREATE TABLE IF NOT EXISTS public.crew_personal_rest_periods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  organization_slug text NOT NULL,
  start_date        date NOT NULL,                 -- restdates.StartDate
  end_date          date NOT NULL,                 -- restdates.EndDate (주차 [start,end] 와 overlap 판정)
  source_system     text NOT NULL,                 -- hrdb/oranke/olympus (provenance)
  legacy_user_id    integer,                        -- PMS UserId (provenance)
  source_rest_id    integer,                        -- PMS restdates.DateId (멱등·provenance)
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_personal_rest_periods_src_uq UNIQUE (source_system, source_rest_id)
);
CREATE INDEX IF NOT EXISTS crew_personal_rest_periods_org_dates_idx
  ON public.crew_personal_rest_periods (organization_slug, start_date, end_date);
CREATE INDEX IF NOT EXISTS crew_personal_rest_periods_user_idx
  ON public.crew_personal_rest_periods (user_id);

-- ── 2) 운영진 표식 (회원명부 제외용, test 와 분리) ──
CREATE TABLE IF NOT EXISTS public.operator_markers (
  user_id           uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  organization_slug text NOT NULL,
  source_system     text,
  legacy_user_id    integer,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_markers_org_idx
  ON public.operator_markers (organization_slug);

-- ── 3) 회원명부 모드 게이트(org allowlist) ──
CREATE TABLE IF NOT EXISTS public.weekly_league_roster_orgs (
  organization_slug text PRIMARY KEY,
  enabled           boolean NOT NULL DEFAULT true,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 적용 후: 별도 ingest 스크립트로 데이터 적재(멱등 upsert).
--   scripts/apply-weekly-league-member-roster.mjs (restdates 109 · operator 12 · 이유나 1 · gate encre)
