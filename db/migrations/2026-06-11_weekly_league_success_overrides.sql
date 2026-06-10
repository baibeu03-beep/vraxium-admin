-- 2026-06-11_weekly_league_success_overrides.sql
-- weekly-league success/fail 표시값 정합 — 주차별 집계 override(행정 공표 실측).
--
-- 배경: total/rest 는 회원명부 정합으로 일치. success/fail 은 PMS 내부식 재현 시 잔차(W9~W13 −1·W1 +21).
--   → 식 복제 대신 oranke 보정 SoT(cluster4_weekly_ranking_exceptions)와 동일한 "관리 데이터 보정" 방식으로,
--      주차별 PMS 실측 성공수를 override 한다. (cluster4_weekly_ranking_exceptions 는 exception_type CHECK 제약이
--      있어 새 타입 불가 → 전용 격리 테이블 신설. oranke 로직 테이블 무접촉.)
--
-- 원칙:
--   - 사람별 verdict 아님 — 주차별 집계 표시값 보정.
--   - weekly-league(게이트 ON org) 회원명부 모드에서만 소비. total/rest 무접촉, success/fail split 만 override.
--     fail = nonRest(=total−rest) − growth_success.
--   - user_week_statuses 무수정(개인카드/growth/resume/snapshot 무영향). oranke/phalanx 행 없음 → 불변.
--   - source 로 provenance(PMS 화면 실측) 보존.

CREATE TABLE IF NOT EXISTS public.weekly_league_success_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_slug text NOT NULL,
  week_start_date   date NOT NULL,                 -- weeks.start_date (월) — weekly-league 조인 키
  growth_success    integer NOT NULL CHECK (growth_success >= 0),  -- PMS 실측 성공 인원(fail=nonRest−이값)
  source            text NOT NULL,                 -- provenance: 'pms_screen_2026spring' 등
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_league_success_overrides_org_week_uq UNIQUE (organization_slug, week_start_date)
);
CREATE INDEX IF NOT EXISTS weekly_league_success_overrides_org_idx
  ON public.weekly_league_success_overrides (organization_slug);

-- 적용 후: encre 7주차(W1=51·W5=108·W9=105·W10=113·W11=108·W12=106·W13=99) ingest(멱등 upsert) +
--   lib(front weekly-league.ts / admin weeklyLeaguePmsAggregation.ts 미러) 회원명부 모드 override read.
