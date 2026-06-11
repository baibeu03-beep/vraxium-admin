-- 2026-06-11_weekly_league_member_start.sql
-- weekly-league 전용 StartDate 격리 — 공유 user_profiles.activity_started_at 무수정.
--
-- 배경: phalanx(olympus) admin activity_started_at 이 2026-05-04(이관일 단일값, 오류)이고,
--   실제 olympus StartDate(2025~2026-03)와 불일치. 공유 필드를 정정하면 resume/cluster-3/growth/snapshot
--   에 파급(특히 W1~W9 봄 데이터 미이관 gap 으로 빈 주차/미인정 증가) → 격리 원칙 적용.
--
-- 원칙:
--   - user_profiles.activity_started_at 무수정(개인카드/resume/cluster-3/growth/snapshot 무영향).
--   - weekly-league(회원명부 모드) 모집단 StartDate 필터에서만 member_start_date 사용:
--       effectiveStart = weekly_league_member_start.member_start_date ?? activity_started_at
--   - 게이트 ON org 만 소비. 미등록 org 무관. source 로 provenance(olympus usersinfo.StartDate) 보존.

CREATE TABLE IF NOT EXISTS public.weekly_league_member_start (
  user_id           uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  organization_slug text NOT NULL,
  member_start_date date NOT NULL,             -- olympus usersinfo.StartDate (실제 멤버십 시작)
  source            text NOT NULL,             -- 'olympus_usersinfo'
  legacy_user_id    integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weekly_league_member_start_org_idx
  ON public.weekly_league_member_start (organization_slug);

-- 적용 후: phalanx 29행 ingest(올림푸스 StartDate) + (별도) 권원중·권희윤 2행.
--   lib(front weekly-league.ts / admin 미러): 회원명부 모드 StartDate 필터에 effectiveStart 적용.
