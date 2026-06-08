-- 2026-06-07_org_week_thresholds.sql
-- 조직별 "주차 인정 point.check 기준값" SoT.
--
-- 배경 (2026-06-07 B안 확정 — claudedocs/org-week-thresholds-design-20260607.md):
--   weeks.check_threshold 는 B7 apply 로 ORANKE weekssettings.confirmStar 가 백필된
--   단일 컬럼이라, hrdb(encre)/olympus(phalanx) 의 서로 다른 confirmStar 를 동시에
--   표현할 수 없다. 본 테이블이 조직 차원을 추가한다.
--
-- 해석 순서 (코드 계약 — lib/lineAvailability.ts):
--   1) org_week_thresholds(week_id, organization_slug)
--   2) 없으면 weeks.check_threshold (존치 — 공통 폴백, B7 백필값)
--   3) 없으면 DEFAULT_WEEK_CHECK_THRESHOLD = 30
--
-- 정책:
--   - organization_slug 는 **source_system 매핑만**으로 결정한다
--     (lib/pmsMigration.ts: hrdb→encre · oranke→oranke · olympus→phalanx).
--     usersinfo.Team 은 team_name 전용 — org 파생 금지.
--   - check_threshold NOT NULL: "org 행 존재 = 값 보유" 강제.
--     조직 오버라이드 해제 = 행 삭제(폴백 복귀). weeks 컬럼의 NULL=기본값 의미론과 혼선 방지.
--   - 판정 전환(enforce) SoT 는 user_weekly_points.checks_migrated 그대로 — 본 테이블은
--     기준값만 공급하며 enforce 여부에 관여하지 않는다.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.org_week_thresholds (
  week_id           uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  organization_slug text NOT NULL
    CHECK (organization_slug IN ('encre', 'oranke', 'phalanx')),
  check_threshold   integer NOT NULL CHECK (check_threshold >= 0),

  -- 이관 provenance (legacy_point_ledger 와 동일 계약)
  source_system     text NULL,     -- 'oranke' | 'hrdb' | 'olympus' | NULL(관리자 수동)
  source_table      text NULL,     -- 예: 'hrdb.weekssettings' (소스 프리픽스 네임스페이스)
  source_pk         text NULL,     -- 소스 행 PK
  inferred          boolean NOT NULL DEFAULT false,  -- false=원본 직접값 / true=보간·유추
  payload           jsonb NULL,    -- 원본 행 스냅 (confirmStar·StartDate 등 감사용)

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (week_id, organization_slug)
);

-- 이관 멱등 키: 소스 행 1개 = org 행 1개 (수동 행 source_pk NULL 은 제외)
CREATE UNIQUE INDEX IF NOT EXISTS uq_owt_source
  ON public.org_week_thresholds (source_table, source_pk)
  WHERE source_pk IS NOT NULL;

COMMENT ON TABLE public.org_week_thresholds IS
  '조직별 주차 인정 point.check 기준값. 해석: org행 → weeks.check_threshold → 30. organization_slug 는 source_system 매핑 SoT(lib/pmsMigration.ts) — Team 파생 금지.';
COMMENT ON COLUMN public.org_week_thresholds.check_threshold IS
  '그 (주차, 조직)의 주차 인정 point.check 기준값. NOT NULL — 오버라이드 해제는 행 삭제.';
COMMENT ON COLUMN public.org_week_thresholds.inferred IS
  'false=소스 원본 직접값(weekssettings.confirmStar 등) / true=보간·유추 — 백필 리포트 표식.';
